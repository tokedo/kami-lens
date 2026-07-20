/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/engine/recs/index.ts
 * changes:  partial port (M0) — upstream re-exports Component, Indexer,
 *           Entity, System, World, Query, utils as well; those modules land
 *           with M1 (sync core) and their lines are restored here then.
 */

export * from "./types";
export * from "./constants";
