/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/components/definitions/StatComponent.ts
 * changes:  none
 */

import { defineComponent, Metadata, Type, World } from 'engine/recs';

export type StatComponent = ReturnType<typeof defineStatComponent>;

// Stat is a struct that holds the modifying values of a core stat.
// The given stat's total (on the entity) is calculated as:
// Total = (1 + boost) * (base + shift)
export function defineStatComponent(world: World, name: string, contractId: string) {
  return defineComponent<{ value: Type.Number }, Metadata>(
    world,
    {
      /**
       * base: base value of the stat
       * shift: fixed +/- shift on the base stat
       * boost: % multiplier on post-shifted stat (3 decimals of precision)
       * sync: the last synced value of stat (optional, for depletable stats)
       */
      value: Type.Number, // the current value of the stat
    },
    {
      id: name,
      metadata: {
        contractId: contractId,
      },
    }
  );
}
