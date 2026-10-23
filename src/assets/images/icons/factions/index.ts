/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/assets/images/icons/factions/index.ts
 * changes:  png imports replaced by same-named consts holding the upstream
 *           asset path as a stable string token (headless port: no bundler
 *           asset pipeline; icons are media, not formulas — DESIGN §3.3).
 *           Export structure and names verbatim.
 */

const nursery = 'assets/images/icons/factions/kamigotchi_nursery.png';
const agency = 'assets/images/icons/factions/kamigotchi_tourism_agency.png';
const mina = 'assets/images/icons/factions/minas_shop.png';

export const FactionIcons = {
  agency,
  mina,
  nursery,
};
