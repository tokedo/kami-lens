/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/assets/images/icons/factions/index.ts
 * changes:  png imports replaced by same-named consts holding the upstream
 *           asset path as a stable string token (headless port: no bundler
 *           asset pipeline; icons are media, not formulas — DESIGN §3.3).
 *           Export structure and names verbatim.
 */

const nursery = 'assets/images/icons/menu/obolshop_3.png';
const agency = 'assets/images/icons/factions/kamigotchi_tourism_agency.png';
const mina = 'assets/images/icons/factions/minas_shop.png';

export const FactionIcons = {
  agency,
  mina,
  nursery,
};
