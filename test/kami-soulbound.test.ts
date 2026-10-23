// 1.1.0 (§3.19): a kami read names its soulbind.
//
// The contracts lock a kami for 3 days when the newbie vendor sells it
// (NewbieVendorBuySystem → LibSoulbound.set), and from upstream 04cb25f8
// KamiSend, KamiGachaReroll and KamiSacrificeCommit check the lock beside
// KamiMarketList, KamiMarketAcceptOffer and Kami721Unstake — each reverts
// "kami is soulbound" while block.timestamp < the stored expiry. The expiry is
// a ValueComponent value at keccak256(abi.encode(kamiID, "SOULBOUND")) — the
// NON-packed encoding — so this test derives the key itself, independently of
// the vendored getter, and checks the served value against it.

import Ajv from 'ajv/dist/2020';
import { AbiCoder, keccak256 } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import * as clock from 'clock';
import { setComponent } from 'engine/recs';
import { formatEntityID } from 'engine/utils';
import { hashArgs } from 'network/shapes/utils';
import { resetIncompleteRows } from '../src/projection-health';
import { loadSchema, serveQuery } from '../src/queries';
import { addAccount, addKami, makeMirror, type SyntheticMirror } from './support/mirror';

const ajv = new Ajv({ strict: true, allErrors: true });
for (const q of ['kami', 'party', 'node']) ajv.addSchema(loadSchema(q as never), q);
const valid = (q: string, data: unknown) => {
  const ok = ajv.validate(q, data);
  if (!ok) throw new Error(`${q} schema: ${ajv.errorsText(ajv.errors)}`);
  return ok;
};
const serve = (m: SyntheticMirror, q: string, args: string[]) =>
  serveQuery(m, q, args, { stale: false, mode: 'daemon' });

const nowSec = () => Math.floor(Date.now() / 1000);
const kamiId = (index: number) => hashArgs(['kami.id', index], ['string', 'uint32']);

/** LibSoulbound._entity: keccak256(abi.encode(kamiID, "SOULBOUND")) */
function soulboundKey(index: number): string {
  const coder = AbiCoder.defaultAbiCoder();
  return formatEntityID(keccak256(coder.encode(['uint256', 'string'], [kamiId(index), 'SOULBOUND'])));
}

function bind(m: SyntheticMirror, index: number, until: number) {
  const e = m.world.registerEntity({ id: soulboundKey(index) as never });
  // the decoder renders a uint256 as '0x' + hex
  setComponent(m.components.Value, e, { value: ('0x' + until.toString(16)) as unknown as number });
}

beforeEach(() => {
  clock.reset();
  resetIncompleteRows();
});

describe('1.1.0: kami serves soulboundUntil', () => {
  it('a bound kami serves its expiry; an unbound one serves 0', async () => {
    const m = makeMirror(8_000);
    const t = nowSec();
    addKami(m, { index: 501, state: 'RESTING', lastTime: t - 60 });
    addKami(m, { index: 502, state: 'RESTING', lastTime: t - 60 });
    bind(m, 501, t + 1_000);
    const bound = (await serve(m, 'kami', ['501'])).data as Record<string, unknown>;
    expect(bound.soulboundUntil).toBe(t + 1_000);
    expect(valid('kami', bound)).toBe(true);
    const free = (await serve(m, 'kami', ['502'])).data as Record<string, unknown>;
    expect(free.soulboundUntil).toBe(0);
    expect(valid('kami', free)).toBe(true);
  });

  it('a lapsed bind still serves its (past) expiry — the raw fact, not a verdict', async () => {
    const m = makeMirror(8_000);
    const t = nowSec();
    addKami(m, { index: 503, state: 'RESTING', lastTime: t - 60 });
    bind(m, 503, t - 5);
    const d = (await serve(m, 'kami', ['503'])).data as Record<string, unknown>;
    expect(d.soulboundUntil).toBe(t - 5);
  });

  it('party rows carry it; node occupant rows (vitals) do not', async () => {
    const m = makeMirror(8_000);
    const t = nowSec();
    addKami(m, { index: 511, state: 'RESTING', lastTime: t - 60 });
    addKami(m, { index: 512, state: 'HARVESTING', node: 3, lastTime: t - 600 });
    addAccount(m, 41, [511, 512]);
    bind(m, 512, t + 3 * 86_400);
    const party = (await serve(m, 'party', ['41'])).data as { kamis: Record<string, unknown>[] };
    expect(party.kamis.map((k) => k.soulboundUntil)).toEqual([0, t + 3 * 86_400]);
    expect(valid('party', party)).toBe(true);
    const node = (await serve(m, 'node', ['3', '--with-vitals'])).data as {
      harvests: { vitals?: Record<string, unknown> }[];
    };
    expect(node.harvests[0]!.vitals).toBeDefined();
    expect('soulboundUntil' in node.harvests[0]!.vitals!).toBe(false);
  });

  it('it is the last unconditional key; the --stats block still comes after it', async () => {
    const m = makeMirror(8_000);
    addKami(m, { index: 521, state: 'RESTING', lastTime: nowSec() - 60 });
    const plain = Object.keys((await serve(m, 'kami', ['521'])).data as object);
    expect(plain[plain.length - 1]).toBe('soulboundUntil');
    const withStats = Object.keys((await serve(m, 'kami', ['521', '--stats'])).data as object);
    expect(withStats.slice(-3)).toEqual(['soulboundUntil', 'stats', 'affinities']);
  });
});
