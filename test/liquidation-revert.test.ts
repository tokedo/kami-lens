// 1.1.0 (§3.19, item 7.3): a liquidation the chain would revert is never
// previewed as eligible.
//
// HarvestLiquidateSystem pays the victim's salvage first and then computes
// the killer's spoils from `bounty - salvage`. LibKill.calcSalvage pays
// `bounty × ratio` while `ratio / precision > 1` is false in INTEGER
// division — so a salvage ratio in (1.0, 2.0) (victim power 101–199 with no
// bonus on the live config [0, 2, 0, 3]) pays MORE than the bounty, the
// subtraction underflows and the liquidation reverts. Until 1.1.0 the node
// preview served such a target as eligible, with a salvage above the bounty.
// Now: `eligible: false`, `reason: SALVAGE_EXCEEDS_BOUNTY` (after the
// attacker's gates and the threshold, as the chain checks them), spoils and
// recoil 0, and `--eligible-only` leaves the row out — all read off the
// numbers the row serves (salvage > vitals.musuAccrued).

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

describe('1.1.0: a liquidation the chain would revert is not previewed as eligible', () => {
  it('victim power 120: salvage above the bounty → eligible false, SALVAGE_EXCEEDS_BOUNTY, spoils and recoil 0', async () => {
    const d = await read(world());
    const row = d.harvests.find((h) => h.kami.index === 911)!;
    expect(row.vitals!.musuAccrued).toBeGreaterThan(4);
    expect(row.liquidation!.salvage).toBeGreaterThan(row.vitals!.musuAccrued);
    expect(row.liquidation!.margin).toBeGreaterThan(0); // in reach by threshold…
    expect(row.liquidation).toMatchObject({ eligible: false, reason: 'SALVAGE_EXCEEDS_BOUNTY', spoils: 0, recoil: 0 });
    expect(ajv.validate('node', d)).toBe(true);
  });

  it('victim power 20 on the same node: an ordinary eligible preview', async () => {
    const d = await read(world());
    const row = d.harvests.find((h) => h.kami.index === 912)!;
    expect(row.liquidation!.salvage).toBeLessThanOrEqual(row.vitals!.musuAccrued);
    expect(row.liquidation!.eligible).toBe(true);
    expect(row.liquidation!.reason).toBeUndefined();
  });

  it('--eligible-only leaves the reverting target out', async () => {
    const d = await read(world(), ['--eligible-only']);
    expect(d.harvests.map((h) => h.kami.index)).toEqual([912]);
    expect(d.harvestsEligible).toBe(1);
  });
});
