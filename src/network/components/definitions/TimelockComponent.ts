/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/components/definitions/TimelockComponent.ts
 * changes:  none
 */

import { Type, World, defineComponent } from 'engine/recs';

export function defineTimelockComponent(world: World, name: string, contractId: any) {
  return defineComponent(
    world,
    {
      target: Type.String,
      value: Type.Number,
      salt: Type.Number,
    },
    {
      id: name,
      metadata: {
        contractId: contractId,
      },
    }
  );
}
