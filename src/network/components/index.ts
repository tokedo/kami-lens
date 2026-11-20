/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
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
