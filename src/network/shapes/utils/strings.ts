/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/utils/strings.ts
 * changes:  none
 */

export function capitalize(val: string) {
  val = val.toLowerCase();
  return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}
