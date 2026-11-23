/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/network/components/definitions/NumberComponent.ts
 * changes:  none
 */

import { defineComponent, Metadata, Type, World } from 'engine/recs';

export function defineNumberComponent(
  world: World,
  name: string,
  contractId: string,
  indexed?: boolean
) {
  return defineComponent<{ value: Type.Number }, Metadata>(
    world,
    { value: Type.Number },
    { id: name, metadata: { contractId: contractId }, indexed: indexed }
  );
}
