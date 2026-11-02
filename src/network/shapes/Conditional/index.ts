/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
 * path:     packages/client/src/network/shapes/Conditional/index.ts
 * changes:  none
 */

export {
  checkBoolean,
  checkCondition,
  checkConditions,
  checkCurrent,
  checkLogicOperator,
  checkerSwitch,
  parseTargetShape,
  parseToInitCon,
  passesConditions,
} from './functions';
export { parseConditionalText, parseConditionalTracking } from './interpretation';
export { getConditionsOf, getConditionsOfID } from './queries';
export { getCondition } from './types';

export type {
  Condition,
  Options as ConditionOptions,
  HANDLER,
  OPERATOR,
  Status,
  Target,
} from './types';
