/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/assets/images/icons/phases/index.ts
 * changes:  image imports replaced by same-named consts holding the upstream
 *           asset path as a stable string token (headless port: no bundler
 *           asset pipeline; icons are media, not formulas — DESIGN §3.3).
 *           Export structure and names verbatim.
 */

const DaylightIcon = 'assets/images/icons/phases/daylight.png';
const EvenfallIcon = 'assets/images/icons/phases/evenfall.png';
const MoonsideIcon = 'assets/images/icons/phases/moonside.png';

export { DaylightIcon, EvenfallIcon, MoonsideIcon };
