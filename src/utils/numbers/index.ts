/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/utils/numbers/index.ts
 * changes:  partial port — upstream also exports from ./bigint, ./balances,
 *           ./eth, ./percents, ./rates (display helpers used by the UI /
 *           projection layer; they port with M2). The hex line is verbatim.
 */

export { numberToHex, uint8ArrayToHexString } from './hex';
