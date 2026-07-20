/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/components/definitions/StringComponent.ts
 * changes:  none
 */

import { defineComponent, Metadata, Type, World } from 'engine/recs';

export function defineStringComponent(
  world: World,
  name: string,
  contractId: string,
  indexed?: boolean
) {
  return defineComponent<{ value: Type.String }, Metadata>(
    world,
    { value: Type.String },
    { id: name, metadata: { contractId: contractId }, indexed: indexed }
  );
}
