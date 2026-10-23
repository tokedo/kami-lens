/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/network/components/index.ts
 * changes:  none
 */

export {
  defineBoolComponent,
  defineDevHighlightComponent,
  defineLoadingStateComponent,
  defineNumberArrayComponent,
  defineNumberComponent,
  defineStatComponent,
  defineStringArrayComponent,
  defineStringComponent,
  defineTimelockComponent,
} from './definitions';
export { createComponents } from './register';

export type { StatComponent } from './definitions';
export type { Components } from './register';
