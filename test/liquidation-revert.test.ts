// 1.1.0 (§3.19, item 7.3): a liquidation the chain would revert is never
// previewed as eligible. 1.2.0: the chain no longer reverts on the salvage.
//
// HarvestLiquidateSystem pays the victim's salvage first and then computes
// the killer's spoils from `bounty - salvage`. Until 2026-11-20 LibKill
// .calcSalvage paid `bounty × ratio` while `ratio / precision > 1` was false
// in INTEGER division — so a salvage ratio in [1.0, 2.0) (victim power
// 100–199 with no bonus on the live config [0, 2, 0, 3]) paid MORE than the
// bounty, the subtraction underflowed and the liquidation reverted; 1.1.0
// served such a row `eligible: false`, `reason: SALVAGE_EXCEEDS_BOUNTY`.
// Upstream a99b4b64 (deployed 2026-11-20 03:34:35Z; the deployed liquidate
// system is that commit's build, byte for byte) caps the share:
// `ratio >= precision` pays the whole bounty. Such a victim now dies with a
// salvage of its whole bounty, the killer's spoils are 0 (nothing remains),
// and the preview serves it as the chain treats it: eligible, no reason, in
// `--eligible-only`.

import Ajv from 'ajv/dist/2020';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { resetIncompleteRows } from '../src/projection-health';
import { loadSchema, serveQuery } from '../src/queries';
import { addKami, makeMirror, type SyntheticMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(loadSchema('node'), 'node');
const nowSec = () => Math.floor(Date.now() / 1000);

type Liq = { eligible: boolean; reason?: string; threshold: number; margin: number; spoils: number; salvage: number; recoil: number };
type Row = { kami: { index: number }; vitals?: { musuAccrued: number; hp: { current: number } }; liquidation?: Liq };

/** a strong attacker (violence 200) and two occupants of node 7 with low
 * harmony and health: one of victim power 120 (salvage ratio 1.2), one of
 * power 20 (ratio 0.2) */
function world(): SyntheticMirror {
  const m = makeMirror(6_000);
  const t = nowSec();
  addKami(m, { index: 901, state: 'RESTING', lastTime: t - 3_600, stats: { violence: 200, harmony: 30 } });
  for (const [index, power] of [[911, 120], [912, 20]] as const) {
    addKami(m, { index, state: 'HARVESTING', node: 7, lastTime: t - 7_200, hp: { base: 100, sync: 30 }, stats: { power, harmony: 5 } });
  }
  return m;
}

const read = async (m: SyntheticMirror, extra: string[] = []) =>
  (await serveQuery(m, 'node', ['7', '901', '--with-vitals', ...extra], { stale: false, mode: 'daemon' })).data as {
    harvests: Row[];
    harvestsEligible?: number;
  };

beforeEach(() => {
  clock.reset();
  resetIncompleteRows();
});

describe('1.2.0: a salvage ratio from 1.0 takes the whole bounty, and the liquidation goes through', () => {
  it('victim power 120: salvage = the bounty → eligible, no reason, spoils 0', async () => {
    const d = await read(world());
    const row = d.harvests.find((h) => h.kami.index === 911)!;
    expect(row.vitals!.musuAccrued).toBeGreaterThan(4);
    expect(row.liquidation!.salvage).toBe(row.vitals!.musuAccrued);
    expect(row.liquidation!.margin).toBeGreaterThan(0); // in reach by threshold
    expect(row.liquidation!.eligible).toBe(true);
    expect(row.liquidation!.reason).toBeUndefined();
    expect(row.liquidation!.spoils).toBe(0);
    expect(ajv.validate('node', d)).toBe(true);
  });

  it('victim power 20 on the same node: an ordinary eligible preview, a share of the bounty', async () => {
    const d = await read(world());
    const row = d.harvests.find((h) => h.kami.index === 912)!;
    expect(row.liquidation!.salvage).toBeLessThan(row.vitals!.musuAccrued);
    expect(row.liquidation!.eligible).toBe(true);
    expect(row.liquidation!.reason).toBeUndefined();
  });

  it('--eligible-only keeps both targets', async () => {
    const d = await read(world(), ['--eligible-only']);
    expect(d.harvests.map((h) => h.kami.index)).toEqual([911, 912]);
    expect(d.harvestsEligible).toBe(2);
  });

  it('no served salvage ever exceeds the row\'s bounty (SALVAGE_EXCEEDS_BOUNTY is not produced)', async () => {
    const m = makeMirror(6_000);
    const t = nowSec();
    addKami(m, { index: 901, state: 'RESTING', lastTime: t - 3_600, stats: { violence: 200, harmony: 30 } });
    const powers = [0, 50, 99, 100, 101, 150, 199, 200, 250];
    powers.forEach((power, i) =>
      addKami(m, { index: 920 + i, state: 'HARVESTING', node: 7, lastTime: t - 7_200, hp: { base: 100, sync: 30 }, stats: { power, harmony: 5 } })
    );
    const d = await read(m, ['--full']);
    for (const row of d.harvests.filter((h) => h.kami.index >= 920)) {
      expect(row.liquidation!.salvage).toBeLessThanOrEqual(row.vitals!.musuAccrued);
      expect(row.liquidation!.reason).not.toBe('SALVAGE_EXCEEDS_BOUNTY');
    }
  });
});
