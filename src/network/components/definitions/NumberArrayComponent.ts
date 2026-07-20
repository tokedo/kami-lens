/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/components/definitions/NumberArrayComponent.ts
 * changes:  none
 */

import { defineComponent, Type, World } from 'engine/recs';

export function defineNumberArrayComponent(world: World, name: string, contractId: string) {
  return defineComponent(
    world,
    {
      value: Type.NumberArray,
    },
    {
      id: name,
      metadata: {
        contractId: contractId,
      },
    }
  );
}
