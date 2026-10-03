/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
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
