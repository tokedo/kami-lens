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
  /** Kamiden feed service (DESIGN §3.2: SOFT dependency — outage degrades
   * feed rows only, never daemon liveness). Upstream creates the Kamiden
   * channel on the Kamigaze URL (clients/kamiden/client.ts reads
   * VITE_KAMIGAZE_URL — both services share the endpoint at the pin), so
   * the default is the resolved kamigazeUrl; undefined = feeds disabled,
   * kamiden-sourced rows degrade visibly (M4). */
  kamidenUrl?: string;
  /** feed ring buffer capacity, in events (M4; oldest evicted first) */
  kamidenBufferCapacity: number;
  /** chat kill-switch (DESIGN §3.10): false removes the chat query */
  chatEnabled: boolean;
  /** chat oversize threshold, UTF-8 bytes of one message body: larger
   * bodies are withheld-with-receipt (DESIGN §3.10 — never truncated;
   * explicit oversize opt-in serves them verbatim) */
  chatMaxBytes: number;
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

  // Kamiden defaults to the Kamigaze endpoint (upstream parity — see the
  // KamiLensConfig field comment). KAMI_LENS_KAMIDEN_URL=none disables feeds.
  const envKamiden = env('KAMI_LENS_KAMIDEN_URL');
  const kamidenUrl =
    'kamidenUrl' in overrides
      ? overrides.kamidenUrl
      : envKamiden === 'none'
        ? undefined
        : (envKamiden ?? kamigazeUrl);

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
    kamidenUrl,
    kamidenBufferCapacity:
      overrides.kamidenBufferCapacity ??
      Number(env('KAMI_LENS_KAMIDEN_BUFFER_CAPACITY') ?? 4096),
    chatEnabled:
      overrides.chatEnabled ?? env('KAMI_LENS_CHAT_ENABLED') !== 'false',
    chatMaxBytes:
      overrides.chatMaxBytes ?? Number(env('KAMI_LENS_CHAT_MAX_BYTES') ?? 4096),
    dataDir: overrides.dataDir ?? getDataDir(),
    checkpointIntervalMs:
      overrides.checkpointIntervalMs ??
      Number(env('KAMI_LENS_CHECKPOINT_INTERVAL_MS') ?? 10 * 60 * 1000),
  };
}
