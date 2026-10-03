// 1.0.0: an over-long socket path is REFUSED, never silently truncated.
//
// A field run (2026-10-03) started the daemon on a data directory that made
// the socket path 131 bytes. The daemon logged the 131-byte path, but the
// kernel bound the path cut to 104 bytes (a file named `l` in the parent
// directory). The Node CLI still found it — it truncates identically — while
// every other client (the reference harness is Python) got "AF_UNIX path too
// long" or "No such file": a healthy daemon no client could reach.
//
// Measured on macOS with Node 22: a path of up to 104 bytes binds as given,
// 105 and over is truncated to 104; Python refuses at 104 (it needs room for
// a NUL). The limit is therefore 103 bytes on macOS and the BSDs and 107 on
// Linux (108-byte sun_path), and both the daemon and the CLI refuse above it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { KamiLensDaemon } from '../src/daemon';
import {
  SOCKET_NAME,
  SOCKET_PATH_MAX_BYTES,
  checkSocketPath,
  socketPath,
  startQuerySocket,
} from '../src/server';

const REPO = path.resolve(import.meta.dirname, '..');
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

/** A data dir whose socket path is exactly `bytes` long. */
function dataDirFor(bytes: number): string {
  root = mkdtempSync(path.join('/tmp', 'klsp-'));
  const pad = bytes - (root.length + 1) - (1 + SOCKET_NAME.length);
  const dir = path.join(root, 'd'.repeat(pad));
  mkdirSync(dir, { recursive: true });
  expect(Buffer.byteLength(socketPath(dir))).toBe(bytes);
  return dir;
}

describe('socket path length (1.0.0)', () => {
  it('the limit is the measured platform limit', () => {
    expect(SOCKET_PATH_MAX_BYTES).toBe(process.platform === 'linux' ? 107 : 103);
  });

  it('the defect, pinned: the OS truncates a long path at bind, and the full path never exists', async () => {
    if (process.platform !== 'darwin') return; // the measurement this release made
    const dir = dataDirFor(131);
    const full = socketPath(dir);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(full, () => resolve()));
    expect(existsSync(full)).toBe(false); // bound somewhere else
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a path at the limit is accepted; one byte over is refused with path, length, limit and remedy', () => {
    expect(() => checkSocketPath(socketPath(dataDirFor(SOCKET_PATH_MAX_BYTES)))).not.toThrow();
    rmSync(root, { recursive: true, force: true });
    const long = socketPath(dataDirFor(SOCKET_PATH_MAX_BYTES + 1));
    let message = '';
    try {
      checkSocketPath(long);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { code?: string }).code).toBe('SOCKET_PATH_TOO_LONG');
    }
    expect(message).toContain(long);
    expect(message).toContain(String(SOCKET_PATH_MAX_BYTES + 1));
    expect(message).toContain(String(SOCKET_PATH_MAX_BYTES));
    expect(message).toContain('--data-dir');
  });

  it('the daemon refuses to start its socket on a long path and binds NOTHING (no truncated file)', () => {
    const dir = dataDirFor(131);
    const daemon = new KamiLensDaemon({ dataDir: dir });
    const before = readdirSync(root, { recursive: true }).length;
    expect(() => startQuerySocket(daemon, dir)).toThrow(/SOCKET_PATH_TOO_LONG|longer than/);
    expect(readdirSync(root, { recursive: true }).length).toBe(before);
  });

  it('the CLI refuses identically instead of connecting to a truncated name', () => {
    const dir = dataDirFor(131);
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(REPO, 'src', 'cli.ts'), 'status', '--data-dir', dir],
      {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      }
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('SOCKET_PATH_TOO_LONG');
    expect(r.stderr).toContain(socketPath(dir));
  }, 60_000);
});
