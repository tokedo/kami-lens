/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
