/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
