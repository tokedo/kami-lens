/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
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
