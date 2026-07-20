/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
