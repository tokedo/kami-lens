// Ported upstream suite (kami-lens 0.6.2 forward-port of
// Asphodel-OS/kamigotchi @ 21f419e6).
// upstream path: packages/client/src/workers/sync/state/index.test.ts
// changes: none — it already imports through the alias.
//
// It looks trivial and is not: it loads the sync state module chain under
// NODE, which is the environment upstream never runs it in. The chain reaches
// the file-snapshot store (swap point 3) and v8.serialize, and a barrel that
// imports something browser-only fails here rather than at a cold boot.

import { describe, expect, it } from 'vitest';

import { createStateCache } from 'workers/sync/state';

describe('state barrel', () => {
  it('loads the sync state module chain under node', () => {
    expect(typeof createStateCache).toBe('function');
  });
});
