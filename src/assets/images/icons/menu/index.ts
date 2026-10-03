/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/assets/images/icons/menu/index.ts
 * changes:  png imports replaced by same-named consts holding the upstream
 *           asset path as a stable string token (headless port: no bundler
 *           asset pipeline; icons are media, not formulas — DESIGN §3.3).
 *           Export structure and names verbatim.
 */

const ChatIcon = 'assets/images/icons/menu/chat.png';
const ExclamIcon = 'assets/images/icons/menu/exclam.png';
const ClockIcon = 'assets/images/icons/menu/clock.png';
const HelpIcon = 'assets/images/icons/menu/help.png';
const InventoryIcon = 'assets/images/icons/menu/inventory.png';
const KamiIcon = 'assets/images/icons/menu/kami.png';
const KamiSendIcon = 'assets/images/icons/menu/kamisend_color.png';
const KamiWikiIcon = 'assets/images/icons/menu/kamiwiki.png';
const ExternalIcon = 'assets/images/icons/menu/link_to_external_apps.png';
const LpFountainIcon = 'assets/images/icons/menu/lp_fountain.png';
const MapIcon = 'assets/images/icons/menu/map.png';
const MoreIcon = 'assets/images/icons/menu/more.png';
const ObolShopIcon = 'assets/images/icons/menu/obolshop_3.png';
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
  ExclamIcon,
  ClockIcon,
  ExternalIcon,
  HelpIcon,
  InventoryIcon,
  KamiIcon,
  KamiSendIcon,
  KamiWikiIcon,
  LpFountainIcon,
  MapIcon,
  MarketplaceIcon,
  MoreIcon,
  ObolShopIcon,
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
  exclam: ExclamIcon,
  help: HelpIcon,
  inventory: InventoryIcon,
  kami: KamiIcon,
  kamisend_color: KamiSendIcon,
  kamiwiki: KamiWikiIcon,
  lp_fountain: LpFountainIcon,
  map: MapIcon,
  marketplace: MarketplaceIcon,
  more: MoreIcon,
  obolshop_3: ObolShopIcon,
  operator: OperatorIcon,
  quests: QuestsIcon,
  reset: ResetIcon,
  settings: SettingsIcon,
  social: SocialIcon,
  sudo: SudoIcon,
};
