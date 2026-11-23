/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/engine/executors/index.ts
 * changes:  partial port — upstream also exports createSystemExecutor
 *           (./create) and createNetwork (./network), the transaction
 *           execution machinery. kami-lens is read-only by design (DESIGN
 *           §2): those modules are not ported. clock and utils lines are
 *           verbatim.
 */

export type { ClockConfig } from './clock';
export { createBlockNumberStream } from './utils';
