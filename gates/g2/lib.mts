// Shared helpers for gate G2 (projection). G2.a is hermetic: it operates on
// an existing mirror snapshot artifact (produced by the daemon / G1 runs)
// and never touches the network.

import { keccak256 } from '@mud-classic/utils';
import { createWorld } from 'engine/recs';
import { removeComponent, setComponent, Component, Schema } from 'engine/recs';
import { createComponents } from 'network/components';
import { getStateCacheEntries, StateCache } from 'workers/sync/state';

/** Assemble a recs world + component registry from a StateCache snapshot —
 * the same per-update application loop as applyNetworkUpdates
 * (network/setup/utils.ts), run synchronously without the worker. */
export function buildMirror(cache: StateCache) {
  const world = createWorld();
  const components = createComponents(world);

  const mappings: { [hashedId: string]: string } = {};
  for (const [key, component] of Object.entries(components)) {
    const contractId = component.metadata?.contractId as string | undefined;
    if (!contractId) continue;
    mappings[keccak256(contractId)] = key;
  }

  let applied = 0;
  let unknown = 0;
  for (const update of getStateCacheEntries(cache)) {
    const entity =
      world.entityToIndex.get(update.entity) ?? world.registerEntity({ id: update.entity });
    const componentKey = mappings[update.component];
    const component = componentKey
      ? components[componentKey as keyof typeof components]
      : undefined;
    if (!component) {
      unknown++;
      continue;
    }
    if (update.value === undefined) {
      removeComponent(component as Component<Schema>, entity);
    } else {
      setComponent(component as Component<Schema>, entity, update.value);
    }
    applied++;
  }
  return { world, components, applied, unknown };
}
