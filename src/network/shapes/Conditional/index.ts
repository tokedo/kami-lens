/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
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
