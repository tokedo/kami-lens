/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
