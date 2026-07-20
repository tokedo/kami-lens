/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
