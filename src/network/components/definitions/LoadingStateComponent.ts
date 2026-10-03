/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/components/definitions/LoadingStateComponent.ts
 * changes:  none
 */

import { Type, World, defineComponent } from 'engine/recs';

export function defineLoadingStateComponent(world: World) {
  return defineComponent(
    world,
    {
      state: Type.Number,
      msg: Type.String,
      percentage: Type.Number,
    },
    {
      id: 'LoadingState',
      metadata: {
        contractId: 'component.LoadingState',
      },
    }
  );
}
