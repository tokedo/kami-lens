/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/components/definitions/StringArrayComponent.ts
 * changes:  none
 */

import { defineComponent, Type, World } from 'engine/recs';

export function defineStringArrayComponent(world: World, name: string, contractId: string) {
  return defineComponent(
    world,
    {
      value: Type.StringArray,
    },
    {
      id: name,
      metadata: {
        contractId: contractId,
      },
    }
  );
}
