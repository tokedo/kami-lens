/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
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
