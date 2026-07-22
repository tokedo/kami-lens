// kami-lens native module (not a port): daemon configuration, DESIGN §5.
// M5 completes the precedence chain: explicit overrides (library callers)
// > CLI flags > KAMI_LENS_* env > TOML config file > baked Yominet
// defaults. Every resolved key records WHICH level won (gate G5.c asserts
// the pairwise matrix on the status output's configSources block).
//
// Config file: --config <path> / KAMI_LENS_CONFIG, else
// <platform config dir>/kami-lens/config.toml (~/.config on Linux,
// ~/Library/Application Support on macOS, %LOCALAPPDATA% on Windows).
// A missing default-location file is fine; a named-but-unreadable or
// unparsable file fails loudly — a config that cannot mean what its
// author wrote must never silently fall back (DESIGN §3.1 ethos).

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';

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
  /** optional account index prefilled into the operator-argument queries
   * when the argument is omitted (DESIGN §5 — a convenience prefill for
   * the general tools, never a special path) */
  defaultOperator?: number;
  dataDir: string;
  checkpointIntervalMs: number;
};

export type ConfigSource = 'override' | 'flag' | 'env' | 'file' | 'default';

export type ResolvedConfig = {
  config: KamiLensConfig;
  /** which precedence level produced each key (G5.c) */
  sources: Record<keyof KamiLensConfig, ConfigSource>;
  /** the config file that was read, if any */
  configFile: string | null;
};

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
};

/** Platform data directory (DESIGN §5), overridable via config chain. */
export function getDataDir(): string {
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

/** Platform config directory (DESIGN §5 "~/.config/kami-lens/config.toml
 * or platform equivalent"). */
export function getDefaultConfigFile(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'kami-lens', 'config.toml');
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
        'kami-lens',
        'config.toml'
      );
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'kami-lens', 'config.toml');
  }
}

// TOML key (snake_case) → config field, with the expected primitive type.
const FILE_KEYS: Record<string, { field: keyof KamiLensConfig; type: 'number' | 'string' | 'boolean' }> = {
  chain_id: { field: 'chainId', type: 'number' },
  world_address: { field: 'worldAddress', type: 'string' },
  initial_block: { field: 'initialBlockNumber', type: 'number' },
  rpc_url: { field: 'jsonRpcUrl', type: 'string' },
  rpc_ws_url: { field: 'wsRpcUrl', type: 'string' },
  kamigaze_url: { field: 'kamigazeUrl', type: 'string' },
  kamiden_url: { field: 'kamidenUrl', type: 'string' },
  kamiden_buffer_capacity: { field: 'kamidenBufferCapacity', type: 'number' },
  chat_enabled: { field: 'chatEnabled', type: 'boolean' },
  chat_max_bytes: { field: 'chatMaxBytes', type: 'number' },
  default_operator: { field: 'defaultOperator', type: 'number' },
  data_dir: { field: 'dataDir', type: 'string' },
  checkpoint_interval_ms: { field: 'checkpointIntervalMs', type: 'number' },
};

const ENV_KEYS: Record<string, keyof KamiLensConfig> = {
  KAMI_LENS_CHAIN_ID: 'chainId',
  KAMI_LENS_WORLD_ADDRESS: 'worldAddress',
  KAMI_LENS_INITIAL_BLOCK: 'initialBlockNumber',
  KAMI_LENS_RPC_URL: 'jsonRpcUrl',
  KAMI_LENS_RPC_WS_URL: 'wsRpcUrl',
  KAMI_LENS_KAMIGAZE_URL: 'kamigazeUrl',
  KAMI_LENS_KAMIDEN_URL: 'kamidenUrl',
  KAMI_LENS_KAMIDEN_BUFFER_CAPACITY: 'kamidenBufferCapacity',
  KAMI_LENS_CHAT_ENABLED: 'chatEnabled',
  KAMI_LENS_CHAT_MAX_BYTES: 'chatMaxBytes',
  KAMI_LENS_DEFAULT_OPERATOR: 'defaultOperator',
  KAMI_LENS_DATA_DIR: 'dataDir',
  KAMI_LENS_CHECKPOINT_INTERVAL_MS: 'checkpointIntervalMs',
};

const NUMBER_FIELDS = new Set<keyof KamiLensConfig>([
  'chainId',
  'initialBlockNumber',
  'kamidenBufferCapacity',
  'chatMaxBytes',
  'defaultOperator',
  'checkpointIntervalMs',
]);
const BOOLEAN_FIELDS = new Set<keyof KamiLensConfig>(['chatEnabled']);
/** URL keys accept the literal 'none' = explicitly unset at that level */
const NONEABLE_FIELDS = new Set<keyof KamiLensConfig>(['kamigazeUrl', 'kamidenUrl', 'wsRpcUrl']);

function coerce(field: keyof KamiLensConfig, raw: string): unknown {
  if (NONEABLE_FIELDS.has(field) && raw === 'none') return undefined;
  if (NUMBER_FIELDS.has(field)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`config: ${field} must be a number, got '${raw}'`);
    return n;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (raw !== 'true' && raw !== 'false') throw new Error(`config: ${field} must be true|false, got '${raw}'`);
    return raw === 'true';
  }
  return raw;
}

/** One precedence layer: partial values keyed by config field. */
type Layer = Partial<Record<keyof KamiLensConfig, unknown>>;

function envLayer(): Layer {
  const layer: Layer = {};
  for (const [name, field] of Object.entries(ENV_KEYS)) {
    const raw = env(name);
    if (raw !== undefined) layer[field] = coerce(field, raw);
  }
  return layer;
}

function fileLayer(configFile: string | null): Layer {
  if (!configFile) return {};
  let text: string;
  try {
    text = readFileSync(configFile, 'utf8');
  } catch (e) {
    throw new Error(`config file ${configFile} is not readable: ${e instanceof Error ? e.message : e}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`config file ${configFile} is not valid TOML: ${e instanceof Error ? e.message : e}`);
  }
  const layer: Layer = {};
  for (const [key, value] of Object.entries(parsed)) {
    const spec = FILE_KEYS[key];
    if (!spec) {
      console.warn(`[config] ${configFile}: unknown key '${key}' ignored`);
      continue;
    }
    if (NONEABLE_FIELDS.has(spec.field) && value === 'none') {
      layer[spec.field] = undefined;
      continue;
    }
    if (typeof value !== spec.type) {
      throw new Error(`config file ${configFile}: ${key} must be a ${spec.type}`);
    }
    layer[spec.field] = value;
  }
  return layer;
}

/**
 * Resolve the effective config with per-key provenance.
 * Precedence: overrides (library) > flags (CLI) > env > file > defaults.
 * kamidenUrl's DEFAULT is the resolved kamigazeUrl (upstream parity — the
 * services share an endpoint at the pin); an explicit kamidenUrl at any
 * level, including 'none', wins over that coupling.
 */
export function resolveConfigDetailed(
  overrides: Partial<KamiLensConfig> = {},
  flags: Partial<KamiLensConfig> & { configFile?: string } = {}
): ResolvedConfig {
  // config file location: flag/env named file must exist; the default
  // location is optional
  const namedFile = (flags as { configFile?: string }).configFile ?? env('KAMI_LENS_CONFIG');
  let configFile: string | null = null;
  let file: Layer = {};
  if (namedFile) {
    configFile = namedFile;
    file = fileLayer(namedFile);
  } else {
    const candidate = getDefaultConfigFile();
    try {
      readFileSync(candidate, 'utf8');
      configFile = candidate;
      file = fileLayer(candidate);
    } catch {
      /* no default-location config file — fine */
    }
  }

  const layers: [ConfigSource, Layer][] = [
    ['override', overrides as Layer],
    ['flag', flags as Layer],
    ['env', envLayer()],
    ['file', file],
  ];

  const pick = (field: keyof KamiLensConfig): { value: unknown; source: ConfigSource } | null => {
    for (const [source, layer] of layers) {
      if (Object.prototype.hasOwnProperty.call(layer, field)) {
        return { value: layer[field], source };
      }
    }
    return null;
  };

  const sources = {} as Record<keyof KamiLensConfig, ConfigSource>;
  const take = <T>(field: keyof KamiLensConfig, dflt: T): T => {
    const hit = pick(field);
    if (hit) {
      sources[field] = hit.source;
      return hit.value as T;
    }
    sources[field] = 'default';
    return dflt;
  };

  const kamigazeUrl = take<string | undefined>('kamigazeUrl', YOMINET_DEFAULTS.kamigazeUrl);
  const config: KamiLensConfig = {
    chainId: take('chainId', YOMINET_DEFAULTS.chainId),
    worldAddress: take('worldAddress', YOMINET_DEFAULTS.worldAddress),
    initialBlockNumber: take('initialBlockNumber', YOMINET_DEFAULTS.initialBlockNumber),
    jsonRpcUrl: take('jsonRpcUrl', YOMINET_DEFAULTS.jsonRpcUrl),
    wsRpcUrl: take<string | undefined>('wsRpcUrl', YOMINET_DEFAULTS.wsRpcUrl),
    kamigazeUrl,
    // default couples to the RESOLVED kamigazeUrl, not the baked one
    kamidenUrl: take<string | undefined>('kamidenUrl', kamigazeUrl),
    kamidenBufferCapacity: take('kamidenBufferCapacity', 4096),
    chatEnabled: take('chatEnabled', true),
    chatMaxBytes: take('chatMaxBytes', 4096),
    defaultOperator: take<number | undefined>('defaultOperator', undefined),
    dataDir: take('dataDir', getDataDir()),
    checkpointIntervalMs: take('checkpointIntervalMs', 10 * 60 * 1000),
  };
  return { config, sources, configFile };
}

/** Back-compat resolver (library callers, gates): overrides > env > file >
 * defaults. Same semantics as resolveConfigDetailed with no flag layer. */
export function resolveConfig(overrides: Partial<KamiLensConfig> = {}): KamiLensConfig {
  return resolveConfigDetailed(overrides).config;
}

/** Parse `--key value` CLI flags into a config layer (plus configFile).
 * Returns the layer and the argv positions consumed. Unknown flags are
 * left for the caller. */
export const CONFIG_FLAGS: Record<string, keyof KamiLensConfig | 'configFile'> = {
  '--chain-id': 'chainId',
  '--world-address': 'worldAddress',
  '--initial-block': 'initialBlockNumber',
  '--rpc-url': 'jsonRpcUrl',
  '--rpc-ws-url': 'wsRpcUrl',
  '--kamigaze-url': 'kamigazeUrl',
  '--kamiden-url': 'kamidenUrl',
  '--kamiden-buffer-capacity': 'kamidenBufferCapacity',
  '--chat-enabled': 'chatEnabled',
  '--chat-max-bytes': 'chatMaxBytes',
  '--default-operator': 'defaultOperator',
  '--data-dir': 'dataDir',
  '--checkpoint-interval-ms': 'checkpointIntervalMs',
  '--config': 'configFile',
};

export function parseConfigFlags(argv: string[]): {
  flags: Partial<KamiLensConfig> & { configFile?: string };
  rest: string[];
} {
  const flags: Partial<KamiLensConfig> & { configFile?: string } = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const target = CONFIG_FLAGS[arg];
    if (!target) {
      rest.push(arg);
      continue;
    }
    const raw = argv[i + 1];
    if (raw === undefined) throw new Error(`${arg} needs a value`);
    i++;
    if (target === 'configFile') flags.configFile = raw;
    else (flags as Record<string, unknown>)[target] = coerce(target, raw);
  }
  return { flags, rest };
}
