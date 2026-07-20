import { describe, expect, it } from 'vitest';

import { createDecode } from 'engine/encoders';
import { ComponentValue, EntityID } from 'engine/recs';
import { tripwires } from '../src/tripwires';
import { createStateCache, storeStateEvent, storeStateValues } from 'workers/sync/state';
import { createTransformWorldEvents } from 'workers/sync/stream';
import { NetworkEvents } from 'workers/types';
import { StreamResponse } from 'clients/kamigaze';

// Hygiene divergence (DESIGN §4.1, decision 2026-07-20): an undecodable
// state row is skipped, counted, and logged — never fatal to the sync.
// The poison shape (array-schema component served a single-word payload)
// reproduces the decode failures first observed 2026-07-20 — later traced
// to a kami-lens checkpoint-indexing bug, kept here as the canonical
// undecodable-row shape the divergence guards against.
const BLACKLIST_ID = '0xb3f96e7944f99619a1086b9a1272bbdff635f1cac9c8bf7ba6ce1a9aa202f19c';
const POISON_DATA = Buffer.from(
  'f9351563910978c79517ef6592de2ec5dfab3fc3a4981b2b63349ec963a516e4',
  'hex'
);
// valid uint32[] = [7]: offset word + length word + one element word
const GOOD_DATA = Buffer.from(
  '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000007',
  'hex'
);

describe('undecodable rows are skipped, counted, never fatal', () => {
  it('snapshot path (storeStateValues) stores good rows and skips poison', async () => {
    const decode = createDecode();
    const cache = createStateCache();
    // seed component/entity index tables via a real event
    storeStateEvent(cache, {
      type: NetworkEvents.NetworkComponentUpdate,
      component: BLACKLIST_ID,
      entity: '0xaaa1' as EntityID,
      value: { value: [1] } as unknown as ComponentValue,
      blockNumber: 10,
    });
    storeStateEvent(cache, {
      type: NetworkEvents.NetworkComponentUpdate,
      component: BLACKLIST_ID,
      entity: '0xaaa2' as EntityID,
      value: { value: [2] } as unknown as ComponentValue,
      blockNumber: 10,
    });
    const before = tripwires.decodeFailures;
    const packedGood = [...cache.state.keys()][0]!;
    const packedPoison = [...cache.state.keys()][1]!;

    await storeStateValues(
      cache,
      [
        { packedIdx: packedGood, data: GOOD_DATA },
        { packedIdx: packedPoison, data: POISON_DATA },
      ],
      decode
    );

    expect(tripwires.decodeFailures).toBe(before + 1);
    expect(cache.state.get(packedGood)).toEqual({ value: [7] });
    // poison row skipped — retains the seeded value, not a decode of poison
    expect(cache.state.get(packedPoison)).toEqual({ value: [2] });
  });

  it('stream path (transformWorldEvents) drops only the poison event', async () => {
    const decode = createDecode();
    const transform = createTransformWorldEvents(decode);
    const before = tripwires.decodeFailures;
    const message = {
      blockNumber: 42,
      logIndex: 0,
      prevLogBlockNumber: 41,
      prevLogIndex: 0,
      ecsEvents: [
        {
          eventType: 'ComponentValueSet',
          componentId: BLACKLIST_ID,
          entityId: '0xaaa1',
          txHash: '0x01',
          value: GOOD_DATA,
          txMetadata: undefined,
        },
        {
          eventType: 'ComponentValueSet',
          componentId: BLACKLIST_ID,
          entityId: '0xaaa2',
          txHash: '0x02',
          value: POISON_DATA,
          txMetadata: undefined,
        },
      ],
    } as unknown as StreamResponse;

    const events = await transform(message);
    expect(events).toHaveLength(1);
    expect(events[0]!.value).toEqual({ value: [7] });
    expect(tripwires.decodeFailures).toBe(before + 1);
  });
});
