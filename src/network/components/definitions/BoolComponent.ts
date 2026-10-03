/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/components/definitions/BoolComponent.ts
 * changes:  none
 */

import { defineComponent, Metadata, Type, World } from 'engine/recs';

export function defineBoolComponent(world: World, name: string, contractId: string) {
  return defineComponent<{ value: Type.Boolean }, Metadata>(
    world,
    { value: Type.Boolean },
    { id: name, metadata: { contractId: contractId } }
  );
}
