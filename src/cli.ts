#!/usr/bin/env node
// kami-lens native module (not a port): minimal M1 daemon entry point.
// Runs the sync daemon, logs status transitions as JSON lines, checkpoints
// on SIGINT/SIGTERM, and exits non-zero on terminal bootstrap failure
// (including the documented ERR_NO_SNAPSHOT_SOURCE marker, gate G1.e).
// The full query surface (socket + CLI queries) lands with M3.

import { ERR_NO_SNAPSHOT_SOURCE, KamiLensDaemon } from './daemon';

async function main(): Promise<void> {
  const daemon = new KamiLensDaemon();

  daemon.status$.subscribe((status) => {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        state: status.state,
        msg: status.msg,
        percentage: status.percentage,
        blockNumber: status.blockNumber,
        stateEntries: status.stateEntries,
        tripwires: status.tripwires,
      })
    );
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[kami-lens] ${signal} — checkpointing and shutting down`);
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await daemon.start();
    await daemon.live;
    console.error('[kami-lens] LIVE');
  } catch (e) {
    const error = e as Error & { code?: string };
    console.error(`[kami-lens] fatal: ${error.message}`);
    process.exit(error.code === ERR_NO_SNAPSHOT_SOURCE ? 3 : 1);
  }
}

void main();
