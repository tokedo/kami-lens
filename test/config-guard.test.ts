// A1 — the config-usable guard must be able to see a missing config block.
//
// Until 1.0.0 the guard probed ONE number (the harvest intensity nudge) for
// finiteness, and the ported isFalsey re-read check ORs over sixteen
// sub-blocks, one of which (KAMI_REST_RECOVERY) the live world does not
// define — so the check was always "falsey" and could never tell a hydrated
// config from an absent one. Built from the live world's own field list
// (test/support/mirror.ts, read with `config` on 2026-10-03): with every
// live field present the daemon answers, without any one of them it refuses
// CONFIG_UNAVAILABLE naming the field, and the field the world does not
// define is not required.

import { beforeEach, describe, expect, it } from 'vitest';

import { ArrayCache, ValueCache } from 'app/cache/config/base';
import { REQUIRED_KAMI_CONFIG, missingKamiConfig } from '../src/queries/build';
import { serveQuery } from '../src/queries';
import {
  LIVE_KAMI_CONFIG,
  LIVE_KAMI_CONFIG_UNDEFINED,
  LIVE_KAMI_CONFIG_VALUES,
  addKami,
  makeMirror,
} from './support/mirror';

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  // the config cache keeps a real value for the life of the process; each
  // case here is a different world
  ArrayCache.clear();
  ValueCache.clear();
});

describe('A1: the config guard is built from the fields the live world defines', () => {
  it('requires exactly the live list, and not the field the world lacks', () => {
    const live = [...Object.keys(LIVE_KAMI_CONFIG), ...Object.keys(LIVE_KAMI_CONFIG_VALUES)].sort();
    expect(REQUIRED_KAMI_CONFIG.map((r) => r.field).sort()).toEqual(live);
    for (const f of LIVE_KAMI_CONFIG_UNDEFINED) {
      expect(REQUIRED_KAMI_CONFIG.map((r) => r.field)).not.toContain(f);
    }
  });

  it('a healthy world (every live field, no KAMI_REST_RECOVERY) answers', async () => {
    const m = makeMirror();
    addKami(m, { index: 801, state: 'RESTING', lastTime: nowSec() - 600 });
    expect(missingKamiConfig(m)).toEqual([]);
    const env = await serveQuery(m, 'kami', ['801'], { stale: false, mode: 'daemon' });
    expect((env.data as { hp: { total: number } }).hp.total).toBe(100);
  });

  it('a legitimately all-zero VALUE (KAMI_LIQ_SALVAGE) is present, not missing', () => {
    // [0,2,0,3,0,0,0,0]: all four values are zero, the precisions are not
    expect(LIVE_KAMI_CONFIG.KAMI_LIQ_SALVAGE).toEqual([0, 2, 0, 3, 0, 0, 0, 0]);
    expect(missingKamiConfig(makeMirror())).not.toContain('KAMI_LIQ_SALVAGE');
  });

  it.each(REQUIRED_KAMI_CONFIG.map((r) => r.field))(
    'a world without %s refuses CONFIG_UNAVAILABLE, naming it',
    async (field) => {
      const m = makeMirror(1_000, { omitConfig: [field] });
      addKami(m, { index: 802, state: 'RESTING', lastTime: nowSec() - 600 });
      await expect(
        serveQuery(m, 'kami', ['802'], { stale: false, mode: 'daemon' })
      ).rejects.toMatchObject({ code: 'CONFIG_UNAVAILABLE', message: expect.stringContaining(field) });
    }
  );
});
