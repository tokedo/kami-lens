/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/assets/images/icons/affinities/index.ts
 * changes:  png imports replaced by same-named consts holding the upstream
 *           asset path as a stable string token (headless port: no bundler
 *           asset pipeline; icons are media, not formulas — DESIGN §3.3).
 *           Export structure and names verbatim.
 */

const eerieIcon = 'assets/images/icons/affinities/eerie.png';
const insectIcon = 'assets/images/icons/affinities/insect.png';
const normalIcon = 'assets/images/icons/affinities/normal.png';
const scrapIcon = 'assets/images/icons/affinities/scrap.png';

export { eerieIcon, insectIcon, normalIcon, scrapIcon };
