/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
