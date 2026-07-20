// kami-lens native module (not a port): daemon configuration, DESIGN §5.
// M1 scope: baked Yominet defaults + KAMI_LENS_* env overrides + explicit
// overrides for library use. The full precedence chain (CLI flags > env >
// TOML file > defaults) lands with M5 packaging; env > defaults holds today
// and keeps its slot in that chain.

import os from 'node:os';
import path from 'node:path';

// Production Yominet values from the upstream README (public deployment
// constants, re-verified against the pin; DESIGN §5).
export const YOMINET_DEFAULTS = {
  chainId: 428962654539583,
  worldAddress: '0x2729174c265dbBd8416C6449E0E813E88f43D0E7',
  initialBlockNumber: 44577,
  jsonRpcUrl: 'https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz',
  wsRpcUrl: 'wss://jsonrpc-ws-yominet-1.anvil.asia-southeast.initia.xyz',
  kamigazeUrl: 'https://api.prod.kamigotchi.io',
} as const;

export type KamiLensConfig = {
  chainId: number;
  worldAddress: string;
  initialBlockNumber: number;
  jsonRpcUrl: string;
  wsRpcUrl?: string;
  /** undefined = no snapshot/stream service configured (loud-fail cold start) */
  kamigazeUrl?: string;
  dataDir: string;
  checkpointIntervalMs: number;
};

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
};

/** Platform data directory (DESIGN §5), overridable via KAMI_LENS_DATA_DIR. */
export function getDataDir(): string {
  const override = env('KAMI_LENS_DATA_DIR');
  if (override) return override;
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'kami-lens');
    case 'win32':
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'kami-lens');
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'kami-lens');
  }
}

/**
 * Resolve the effective config: explicit overrides > KAMI_LENS_* env > baked
 * Yominet defaults. Set KAMI_LENS_KAMIGAZE_URL=none (or pass
 * kamigazeUrl: undefined explicitly in overrides) to run without a snapshot
 * service — the daemon then refuses cold starts loudly (DESIGN §3.1).
 */
export function resolveConfig(overrides: Partial<KamiLensConfig> = {}): KamiLensConfig {
  const envKamigaze = env('KAMI_LENS_KAMIGAZE_URL');
  const kamigazeUrl =
    'kamigazeUrl' in overrides
      ? overrides.kamigazeUrl
      : envKamigaze === 'none'
        ? undefined
        : (envKamigaze ?? YOMINET_DEFAULTS.kamigazeUrl);

  return {
    chainId: overrides.chainId ?? Number(env('KAMI_LENS_CHAIN_ID') ?? YOMINET_DEFAULTS.chainId),
    worldAddress:
      overrides.worldAddress ?? env('KAMI_LENS_WORLD_ADDRESS') ?? YOMINET_DEFAULTS.worldAddress,
    initialBlockNumber:
      overrides.initialBlockNumber ??
      Number(env('KAMI_LENS_INITIAL_BLOCK') ?? YOMINET_DEFAULTS.initialBlockNumber),
    jsonRpcUrl: overrides.jsonRpcUrl ?? env('KAMI_LENS_RPC_URL') ?? YOMINET_DEFAULTS.jsonRpcUrl,
    wsRpcUrl:
      'wsRpcUrl' in overrides
        ? overrides.wsRpcUrl
        : (env('KAMI_LENS_RPC_WS_URL') ?? YOMINET_DEFAULTS.wsRpcUrl),
    kamigazeUrl,
    dataDir: overrides.dataDir ?? getDataDir(),
    checkpointIntervalMs:
      overrides.checkpointIntervalMs ??
      Number(env('KAMI_LENS_CHECKPOINT_INTERVAL_MS') ?? 10 * 60 * 1000),
  };
}
