// 1.2.0: an upgrade that maps a new component never resumes from a snapshot
// that decoded it without a schema.
//
// The saved world (workers/sync/state/store.ts) holds DECODED values. A
// build that has no schema for a component decodes its rows with the "No
// schema found" fallback — a bool — and keeps the bool (1.1.1 did exactly
// this for HarvestMultiplier from 2026-11-09: a K of 1000 is stored as
// `true`). Were 1.2.0 to warm-start from that snapshot, the mapped component
// would hold those bools — a node's K read through the low-16-bit rule of
// `true` is 1 — and the incremental refresh after a warm start re-sends only
// what changes, so a node's K, which never changes, would stay wrong.
//
// So the snapshot header names the schema its values were decoded under, a
// snapshot decoded under another (every 1.1.1 snapshot: it names none) is
// discarded on load like a header mismatch, and the boot loads the world
// cold from the state service — which decodes every row under this build's
// schema, so the mirror then holds EVERY HarvestMultiplier value on chain.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDecode, createDecoder } from 'engine/encoders';
import type { EntityID } from 'engine/recs';
import { getStoredMultiplier } from 'network/shapes/Node/multiplier';
import { hashArgs } from 'network/shapes/utils';
import {
  createStateCache,
  loadStateCacheFromStore,
  saveStateCacheToStore,
  storeStateComponents,
  storeStateEntities,
  storeStateValues,
} from 'workers/sync/state';
import { FileStateStore, componentSchemaFingerprint, get as getStateStore } from 'workers/sync/state/store';
import { ComponentsSchema } from 'types/ComponentsSchema';
import { packTuple } from '@mud-classic/utils';

const HARVEST_MULTIPLIER = '0x017545640be52d18b8419842ba4066eb26707a37978580d5a2c11caa5f5b1552';
const header = { chainId: 1337, worldAddress: '0xabc', cacheVersion: 5 };

/** a 32-byte big-endian word, as the state service carries a uint256 */
const word = (n: number): Uint8Array => {
  const b = new Uint8Array(32);
  let v = BigInt(n);
  for (let i = 31; i >= 0 && v > 0n; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
};
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex.replace(/^0x/, '').padStart(64, '0'), 'hex'));

/** The state service's answer for `ks.length` nodes, each with its K, decoded
 * by `decode` exactly as a full load decodes it (storeComponents /
 * storeEntities / storeValues — the code path of every cold boot). */
function coldLoad(ks: number[], decode: (c: string, d: Uint8Array) => unknown) {
  const cache = createStateCache();
  storeStateComponents(cache, [{ idx: 1, id: hexBytes(HARVEST_MULTIPLIER) }] as never);
  const ids = ks.map((_, i) => hashArgs(['node', i + 1], ['string', 'uint32']));
  storeStateEntities(cache, ids.map((id, i) => ({ idx: i + 1, id: hexBytes(id) })) as never);
  storeStateValues(
    cache,
    ks.map((k, i) => ({ packedIdx: packTuple([1, i + 1]), data: word(k) })) as never,
    decode as never
  );
  cache.blockNumber = 9_000;
  cache.lastKamigazeBlock = 9_000;
  cache.kamigazeNonce = 3;
  return { cache, ids };
}

const valuesOf = (cache: ReturnType<typeof createStateCache>) =>
  [...cache.state.values()].map((v) => (v as { value: unknown }).value);

describe('1.2.0: the snapshot names the component schema its values were decoded under', () => {
  let dir: string;
  const file = () => path.join(dir, 'ECSCache-test.v8snap');
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kami-lens-schema-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('this build decodes HarvestMultiplier as the uint256 it is; a build without its schema decoded a bool', () => {
    expect(ComponentsSchema[HARVEST_MULTIPLIER as keyof typeof ComponentsSchema]).toEqual({ keys: ['value'], values: [13] });
    expect(createDecode()(HARVEST_MULTIPLIER, word(1000))).toEqual({ value: '0x3e8' });
    // the "No schema found" fallback 1.1.1 decoded it with
    expect(createDecoder(['value'], [0])(word(1000))).toEqual({ value: true });
  });

  it('a snapshot written before 1.2.0 (no schema in its header) is discarded on load: the boot loads cold', async () => {
    // what a 1.1.1 checkpoint holds: the same rows, decoded as bools
    const fallback = createDecoder(['value'], [0]);
    const { cache } = coldLoad([1000, 1000, 2500], (c, d) => (c === HARVEST_MULTIPLIER ? fallback(d) : createDecode()(c, d)));
    expect(valuesOf(cache)).toEqual([true, true, true]);
    const writer = new FileStateStore(file(), header);
    await saveStateCacheToStore(writer as never, cache);
    // rewrite the header exactly as 1.1.1 wrote it: no componentSchema
    const raw = v8.deserialize(await fs.readFile(file())) as { header: Record<string, unknown>; stores: unknown };
    delete raw.header.componentSchema;
    await fs.writeFile(file(), v8.serialize(raw));

    const reader = new FileStateStore(file(), header);
    await reader.load();
    const restored = await loadStateCacheFromStore(reader as never);
    expect(restored.state.size).toBe(0);
    expect(restored.lastKamigazeBlock).toBe(0);
  });

  it('only a reader of a FROZEN snapshot (the gates\' fixtures) may opt out, by passing null', async () => {
    const { cache } = coldLoad([1000], createDecode());
    await saveStateCacheToStore(new FileStateStore(file(), header, 'another-schema') as never, cache);
    const reader = new FileStateStore(file(), header, null);
    await reader.load();
    expect((await loadStateCacheFromStore(reader as never)).state.size).toBe(1);
  });

  it('a snapshot decoded under a different schema (another build) is discarded too', async () => {
    const { cache } = coldLoad([1000], createDecode());
    await saveStateCacheToStore(new FileStateStore(file(), header, 'another-schema') as never, cache);
    const reader = new FileStateStore(file(), header);
    await reader.load();
    expect((await loadStateCacheFromStore(reader as never)).state.size).toBe(0);
  });

  it('the cold load holds EVERY HarvestMultiplier value as its K, and a snapshot this build wrote resumes with them', async () => {
    const ks = Array.from({ length: 64 }, (_, i) => [100, 800, 1000, 1500, 2500, 60000][i % 6]!);
    const { cache, ids } = coldLoad(ks, createDecode());
    expect(cache.state.size).toBe(64);
    expect(valuesOf(cache).map((v) => getStoredMultiplier(v as string))).toEqual(ks);

    await saveStateCacheToStore(new FileStateStore(file(), header) as never, cache);
    const reader = new FileStateStore(file(), header);
    await reader.load();
    const restored = await loadStateCacheFromStore(reader as never);
    expect(restored.state.size).toBe(64);
    expect(restored.lastKamigazeBlock).toBe(9_000);
    expect(valuesOf(restored).map((v) => getStoredMultiplier(v as string))).toEqual(ks);
    expect(restored.entities.slice(1)).toEqual(ids.map((id) => id as EntityID));
  });

  it('the fingerprint moves when a component is added and not otherwise', () => {
    const base = componentSchemaFingerprint();
    expect(componentSchemaFingerprint({ ...ComponentsSchema })).toBe(base);
    const without = Object.fromEntries(
      Object.entries(ComponentsSchema).filter(([id]) => id !== HARVEST_MULTIPLIER)
    );
    expect(componentSchemaFingerprint(without)).not.toBe(base);
  });

  it('the DAEMON\'s own store factory (getStateStore) discards a pre-1.2.0 snapshot in its data directory', async () => {
    const config = { chainId: 1337, world: '0x00000000000000000000000000000000000000ab' };
    const fallback = createDecoder(['value'], [0]);
    const { cache } = coldLoad([1000, 2500], (c, d) => (c === HARVEST_MULTIPLIER ? fallback(d) : createDecode()(c, d)));
    const writer = await getStateStore(config.chainId, config.world, 5, dir);
    await saveStateCacheToStore(writer as never, cache);
    // strip the schema exactly as 1.1.1 wrote its header
    const f = writer.filePath;
    const raw = v8.deserialize(await fs.readFile(f)) as { header: Record<string, unknown>; stores: unknown };
    delete raw.header.componentSchema;
    await fs.writeFile(f, v8.serialize(raw));
    const reader = await getStateStore(config.chainId, config.world, 5, dir);
    const restored = await loadStateCacheFromStore(reader as never);
    expect(restored.state.size).toBe(0);
    expect(restored.lastKamigazeBlock).toBe(0);
    // and one this build wrote through the same factory resumes
    const { cache: fresh } = coldLoad([1000], createDecode());
    await saveStateCacheToStore((await getStateStore(config.chainId, config.world, 5, dir)) as never, fresh);
    expect((await loadStateCacheFromStore((await getStateStore(config.chainId, config.world, 5, dir)) as never)).state.size).toBe(1);
  });

  it('the fingerprint covers the VALUE TYPES, not only the ids: a component decoded as another type moves it', () => {
    const base = componentSchemaFingerprint();
    const retyped = { ...ComponentsSchema, [HARVEST_MULTIPLIER]: { keys: ['value'], values: [0] } } as never;
    expect(componentSchemaFingerprint(retyped)).not.toBe(base);
    const rekeyed = { ...ComponentsSchema, [HARVEST_MULTIPLIER]: { keys: ['other'], values: [13] } } as never;
    expect(componentSchemaFingerprint(rekeyed)).not.toBe(base);
  });
});
