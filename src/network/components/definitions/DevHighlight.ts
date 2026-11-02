/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/components/definitions/DevHighlight.ts
 * changes:  none
 */

import { defineComponent, Type, World } from 'engine/recs';

/**
 * DevHighlight is for use during development to highlight the positions of
 * entities that you are interacting with.
 * Example: Highlight the Entities that you are currently editing in the ComponentBrowser.
 */
export function defineDevHighlightComponent(world: World) {
  return defineComponent(world, { value: Type.OptionalNumber }, { id: 'DevHighlight' });
}
