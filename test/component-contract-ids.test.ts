// 1.1.0 item 8 (lab audit, 2026-11-02): the component-id map the daemon builds
// at bootstrap (daemon.ts: keccak256(metadata.contractId) → component key) is
// what turns a stream or gapfill event's componentId into a component. When
// the chain returned on 2026-11-02 the studio had deployed a component this
// map did not have (component.time.pause, upstream 8fb6ea58): the daemon
// logged `Unknown component: 0x9ff2…` on every boot and carried the tripwire
// unknownComponentIds in status.degraded for the life of the process. A typo
// in the contract-id string of register.ts reproduces that exactly while
// every other test stays green (the lab's mutation of it survived the
// suite), so this guard pins the mapping itself:
//   - every ComponentsSchema key is the keccak of a registered contract id;
//   - every registered component except the three registry-level ones
//     (Components, Systems, LoadingState — never decoded through the schema)
//     has its keccak in ComponentsSchema;
//   - the pause component in particular: its key, id, hash and schema entry.
// No network, no fixtures: the registry and the schema as shipped.

import { keccak256 } from '@mud-classic/utils';
import { describe, expect, it } from 'vitest';

import { createWorld } from 'engine/recs';
import { createComponents } from 'network/components';
import { ComponentsSchema } from 'types/ComponentsSchema';

const PAUSE_ID = 'component.time.pause';
const PAUSE_HASH = '0x9ff2cdae496c6e761000b25def7fa234d4db19540d7fcf339e66ff95afdd1fc0';
const REGISTRY_LEVEL = new Set(['Components', 'Systems', 'LoadingState']);

function contractIdMap(): Map<string, { key: string; id: string }> {
  const comps = createComponents(createWorld()) as Record<string, { metadata?: { contractId?: string } }>;
  const map = new Map<string, { key: string; id: string }>();
  for (const [key, c] of Object.entries(comps)) {
    const id = c?.metadata?.contractId;
    if (!id) continue;
    map.set(keccak256(id), { key, id });
  }
  return map;
}

describe('the component-id map the daemon decodes events through', () => {
  it('every ComponentsSchema key is the keccak of a registered contract id', () => {
    const map = contractIdMap();
    const orphans = Object.keys(ComponentsSchema).filter((h) => !map.has(h));
    expect(orphans).toEqual([]);
  });

  it('every registered component (bar the registry-level three) is in ComponentsSchema', () => {
    const map = contractIdMap();
    const unmapped = [...map.values()].filter((v) => !REGISTRY_LEVEL.has(v.key) && !(keccak256(v.id) in ComponentsSchema)).map((v) => `${v.key} (${v.id})`);
    expect(unmapped).toEqual([]);
  });

  it('the pause window component maps: TimePause ↔ component.time.pause ↔ 0x9ff2…', () => {
    const map = contractIdMap();
    expect(keccak256(PAUSE_ID)).toBe(PAUSE_HASH);
    expect(map.get(PAUSE_HASH)).toEqual({ key: 'TimePause', id: PAUSE_ID });
    expect((ComponentsSchema as Record<string, unknown>)[PAUSE_HASH]).toEqual({ keys: ['value'], values: [13] });
  });
});
