/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/cache/db.ts
 * changes:  swap point 3 (DESIGN §4.1/§3.5) — upstream's IndexedDB init
 *           machinery is replaced by the single-file binary snapshot in
 *           workers/sync/state/store.ts. Only the cache VERSION constant is
 *           retained (verbatim), so importers keep their upstream import
 *           line and the on-disk cache key stays name-compatible
 *           (ECSCache-<chainId>-<worldAddress>-v5).
 */

export const VERSION = 5;
