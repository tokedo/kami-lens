/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/engine/executors/index.ts
 * changes:  partial port — upstream also exports createSystemExecutor
 *           (./create) and createNetwork (./network), the transaction
 *           execution machinery. kami-lens is read-only by design (DESIGN
 *           §2): those modules are not ported. clock and utils lines are
 *           verbatim.
 */

export type { ClockConfig } from './clock';
export { createBlockNumberStream } from './utils';
