/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/assets/images/icons/menu/index.ts
 * changes:  png imports replaced by same-named consts holding the upstream
 *           asset path as a stable string token (headless port: no bundler
 *           asset pipeline; icons are media, not formulas — DESIGN §3.3).
 *           Export structure and names verbatim.
 */

const ChatIcon = 'assets/images/icons/menu/chat.png';
const ClockIcon = 'assets/images/icons/menu/clock.png';
const HelpIcon = 'assets/images/icons/menu/help.png';
const InventoryIcon = 'assets/images/icons/menu/inventory.png';
const KamiIcon = 'assets/images/icons/menu/kami.png';
const ExternalIcon = 'assets/images/icons/menu/link_to_external_apps.png';
const MapIcon = 'assets/images/icons/menu/map.png';
const MoreIcon = 'assets/images/icons/menu/more.png';
const OperatorIcon = 'assets/images/icons/menu/operator.png';
const MarketplaceIcon = 'assets/images/icons/menu/marketplace.png';
const QuestsIcon = 'assets/images/icons/menu/quests.png';
const ResetIcon = 'assets/images/icons/menu/reset.png';
const SettingsIcon = 'assets/images/icons/menu/settings.png';
const SocialIcon = 'assets/images/icons/menu/social.png';
const SudoIcon = 'assets/images/icons/menu/sudo.png';
const TradeIcon = 'assets/images/icons/menu/trade.png';
const Whispo = 'assets/images/icons/menu/whispo.png';

export {
  ChatIcon,
  ClockIcon,
  ExternalIcon,
  HelpIcon,
  InventoryIcon,
  KamiIcon,
  MapIcon,
  MarketplaceIcon,
  MoreIcon,
  OperatorIcon,
  QuestsIcon,
  ResetIcon,
  SettingsIcon,
  SocialIcon,
  SudoIcon,
  TradeIcon,
  Whispo,
};

export const MenuIcons = {
  clock: ClockIcon,
  trade: TradeIcon,
  whispo: Whispo,
  link_to_external_apps: ExternalIcon,
  chat: ChatIcon,
  help: HelpIcon,
  inventory: InventoryIcon,
  kami: KamiIcon,
  map: MapIcon,
  marketplace: MarketplaceIcon,
  more: MoreIcon,
  operator: OperatorIcon,
  quests: QuestsIcon,
  reset: ResetIcon,
  settings: SettingsIcon,
  social: SocialIcon,
  sudo: SudoIcon,
};
