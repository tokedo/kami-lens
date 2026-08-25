// 0.5.0 (§3.13) — the query ARGUMENT vocabulary and the compact-form
// argument parsing. Hermetic: parseArgs is pure, so the whole routing
// contract is testable without a mirror.
//
// The CLI half of this used to be a hand-written allowlist of three flag
// spellings; anything outside it was routed into the client-flag set and
// dropped without a word, so `quests 78 --full` answered the COMPACT form
// silently. These tests pin the replacement: a query declares its arguments,
// and an undeclared option is an error rather than a different answer.

import { describe, expect, it } from 'vitest';

import { QueryError } from '../src/queries/build';
import { QUERY_NAMES, REGISTRY } from '../src/queries/registry';

describe('declared query arguments (§3.13)', () => {
  it('every declared argument is a `--flag` and is unique per query', () => {
    for (const name of QUERY_NAMES) {
      const args = REGISTRY[name].args ?? [];
      expect(new Set(args).size, `${name} declares a duplicate argument`).toBe(args.length);
      for (const arg of args) {
        expect(arg.startsWith('--'), `${name} declares a non-flag argument ${arg}`).toBe(true);
      }
    }
  });

  it('no query declares a CLIENT flag as its own argument', () => {
    // --prose / --no-authored / --stateless are the CLI's, on every query;
    // a query claiming one would shadow it
    for (const name of QUERY_NAMES) {
      for (const arg of REGISTRY[name].args ?? []) {
        expect(['--prose', '--no-authored', '--stateless']).not.toContain(arg);
      }
    }
  });

  it('every capped or compacted listing declares --full', () => {
    for (const name of ['quests', 'items', 'merchant', 'room', 'node', 'leaderboard', 'trades', 'market', 'party'] as const) {
      expect(REGISTRY[name].args ?? [], `${name} must declare --full`).toContain('--full');
    }
  });

  it('parses --full off every query that declares it, in any position', () => {
    expect(REGISTRY.room.parseArgs(['12', '--full'])).toMatchObject({ index: 12, full: true });
    expect(REGISTRY.room.parseArgs(['--full', '12'])).toMatchObject({ index: 12, full: true });
    expect(REGISTRY.room.parseArgs(['12'])).toMatchObject({ index: 12, full: false });
    expect(REGISTRY.party.parseArgs(['5', '--full'])).toMatchObject({ accountIndex: 5, full: true });
    expect(REGISTRY.leaderboard.parseArgs(['LIQUIDATE', '1', '0', '--full'])).toMatchObject({
      type: 'LIQUIDATE',
      epoch: 1,
      itemIndex: 0,
      full: true,
    });
    expect(REGISTRY.items.parseArgs(['FOOD'])).toMatchObject({ type: 'FOOD', full: false });
    expect(REGISTRY.items.parseArgs([])).toMatchObject({ full: false });
  });

  it('node keeps --with-vitals working beside --full', () => {
    expect(REGISTRY.node.parseArgs(['9', '--with-vitals'])).toMatchObject({
      index: 9,
      withVitals: true,
      full: false,
    });
    expect(REGISTRY.node.parseArgs(['9', '219', '--with-vitals', '--full'])).toMatchObject({
      index: 9,
      attacker: 219,
      withVitals: true,
      full: true,
    });
    // an attacker without vitals is still refused
    expect(() => REGISTRY.node.parseArgs(['9', '219'])).toThrow(QueryError);
  });

  it('quests keys one quest, narrows a view, and refuses a contradictory pair', () => {
    expect(REGISTRY.quests.parseArgs(['78'])).toMatchObject({ accountIndex: 78, full: false });
    expect(REGISTRY.quests.parseArgs(['78', '52'])).toMatchObject({
      accountIndex: 78,
      questIndex: 52,
    });
    expect(REGISTRY.quests.parseArgs(['78', '--open'])).toMatchObject({ view: 'open' });
    expect(REGISTRY.quests.parseArgs(['78', '--accepted'])).toMatchObject({ view: 'accepted' });
    expect(REGISTRY.quests.parseArgs(['78'])).toMatchObject({ view: undefined });
    expect(() => REGISTRY.quests.parseArgs(['78', '--open', '--accepted'])).toThrow(QueryError);
  });

  it('the skills query takes an optional kami index', () => {
    expect(REGISTRY.skills.parseArgs([])).toMatchObject({ kamiIndex: undefined });
    expect(REGISTRY.skills.parseArgs(['219'])).toMatchObject({ kamiIndex: 219 });
  });
});
