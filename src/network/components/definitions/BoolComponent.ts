/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
