/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/utils/logger.ts
 * changes:  swap point 1 (DESIGN §4.1) — browser bindings replaced for Node:
 *           the window/WorkerGlobalScope declarations and window/self
 *           globalScope pick become globalThis; the default level comes from
 *           process.env.KAMI_LENS_LOG_LEVEL instead of
 *           import.meta.env.VITE_LOG_LEVEL; the "[logger:<context>]" banner
 *           logs context "node". The LogLevel enum, level gating, timestamp
 *           format, and the log/log.time API are verbatim.
 */

export enum LogLevel {
  SILENT = -1,
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.SILENT]: 'SILENT',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.TRACE]: 'TRACE',
};

// Default: INFO, configurable via KAMI_LENS_LOG_LEVEL env var
const DEFAULT_LEVEL =
  LogLevel[process.env.KAMI_LENS_LOG_LEVEL as keyof typeof LogLevel] ?? LogLevel.INFO;

let currentLevel: LogLevel = DEFAULT_LEVEL;

// Debug: show what level was loaded
console.log(`[logger:node] initialized with level: ${LEVEL_NAMES[currentLevel]}`);

type GlobalLogControls = {
  setLogLevel: (level: string) => void;
  getLogLevel: () => string;
  resetLogLevel: () => void;
};
const globalScope = globalThis as typeof globalThis & GlobalLogControls;

// Runtime control via console (upstream exposes the same three hooks)
globalScope.setLogLevel = (level: string) => {
  const normalized = level.toUpperCase();
  const found = Object.entries(LEVEL_NAMES).find(([, name]) => name === normalized);
  if (found) {
    currentLevel = Number(found[0]) as LogLevel;
    if (LogLevel.SILENT == Number(found[0])) {
      console.log(
        'The wise speak only of what they know, Gríma son of Gálmód. A witless worm have you become. Therefore be silent'
      );
    }
    console.log(`Log level set to ${normalized}`);
  } else {
    console.log(`Invalid level. Use: ${Object.values(LEVEL_NAMES).join(', ')}`);
  }
};

globalScope.getLogLevel = () => LEVEL_NAMES[currentLevel];

globalScope.resetLogLevel = () => {
  currentLevel = DEFAULT_LEVEL;
  console.log(`Log level reset to ${LEVEL_NAMES[DEFAULT_LEVEL]}`);
};

function timestamp(): string {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  const s = now.getSeconds().toString().padStart(2, '0');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  return `[${h}:${m}:${s}.${ms}]`;
}

export const log = {
  error: (...args: unknown[]) => {
    if (currentLevel >= LogLevel.ERROR) console.error(...args);
  },
  warn: (...args: unknown[]) => {
    if (currentLevel >= LogLevel.WARN) console.warn(...args);
  },
  info: (...args: unknown[]) => {
    if (currentLevel >= LogLevel.INFO) console.log(...args);
  },
  debug: (...args: unknown[]) => {
    if (currentLevel >= LogLevel.DEBUG) console.log('DEBUG', ...args);
  },
  trace: (...args: unknown[]) => {
    if (currentLevel >= LogLevel.TRACE) console.log('TRACE', ...args);
  },
  time: {
    error: (...args: unknown[]) => {
      if (currentLevel >= LogLevel.ERROR) console.error(timestamp(), ...args);
    },
    warn: (...args: unknown[]) => {
      if (currentLevel >= LogLevel.WARN) console.warn(timestamp(), ...args);
    },
    info: (...args: unknown[]) => {
      if (currentLevel >= LogLevel.INFO) console.log(timestamp(), ...args);
    },
    debug: (...args: unknown[]) => {
      if (currentLevel >= LogLevel.DEBUG) console.log(timestamp(), 'DEBUG', ...args);
    },
    trace: (...args: unknown[]) => {
      if (currentLevel >= LogLevel.TRACE) console.log(timestamp(), 'TRACE', ...args);
    },
  },
};
