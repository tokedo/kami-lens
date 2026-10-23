/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/assets/images/icons/stats/index.ts
 * changes:  png imports replaced by same-named consts holding the upstream
 *           asset path as a stable string token (headless port: no bundler
 *           asset pipeline; icons are media, not formulas — DESIGN §3.3).
 *           Export structure and names verbatim.
 */

const HarmonyIcon = 'assets/images/icons/stats/harmony.png';
const HealthIcon = 'assets/images/icons/stats/health.png';
const PowerIcon = 'assets/images/icons/stats/power.png';
const SlotsIcon = 'assets/images/icons/stats/slots.png';
const StaminaIcon = 'assets/images/icons/stats/stamina.png';
const ViolenceIcon = 'assets/images/icons/stats/violence.png';
const ExpIcon = 'assets/images/icons/stats/xp.png';

export { ExpIcon, HarmonyIcon, HealthIcon, PowerIcon, SlotsIcon, StaminaIcon, ViolenceIcon };
export const StatIcons = {
  health: HealthIcon,
  power: PowerIcon,
  violence: ViolenceIcon,
  harmony: HarmonyIcon,
  slots: SlotsIcon,
  stamina: StaminaIcon,
  xp: ExpIcon,
};
