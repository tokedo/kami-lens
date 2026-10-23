/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
