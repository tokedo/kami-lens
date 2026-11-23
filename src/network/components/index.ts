/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
