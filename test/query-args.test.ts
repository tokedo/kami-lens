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

  // --- 0.5.1 (§3.16): the kami-sheet flag ----------------------------------

  it('every surface that projects a kami declares --stats', () => {
    for (const name of ['kami', 'roster', 'party', 'node'] as const) {
      expect(REGISTRY[name].args ?? [], `${name} must declare --stats`).toContain('--stats');
    }
  });

  it('parses --stats in any position, and defaults it off', () => {
    expect(REGISTRY.kami.parseArgs(['307'])).toMatchObject({ index: 307, stats: false });
    expect(REGISTRY.kami.parseArgs(['307', '--stats'])).toMatchObject({ index: 307, stats: true });
    expect(REGISTRY.kami.parseArgs(['--stats', '307'])).toMatchObject({ index: 307, stats: true });
    expect(REGISTRY.roster.parseArgs(['2930'])).toMatchObject({ accountIndex: 2930, stats: false });
    expect(REGISTRY.roster.parseArgs(['2930', '--stats'])).toMatchObject({
      accountIndex: 2930,
      stats: true,
    });
  });

  it('party takes --stats and --full together, in either order', () => {
    expect(REGISTRY.party.parseArgs(['2930'])).toMatchObject({ full: false, stats: false });
    expect(REGISTRY.party.parseArgs(['2930', '--stats'])).toMatchObject({
      accountIndex: 2930,
      full: false,
      stats: true,
    });
    expect(REGISTRY.party.parseArgs(['--full', '2930', '--stats'])).toMatchObject({
      accountIndex: 2930,
      full: true,
      stats: true,
    });
  });

  it('node refuses --stats without --with-vitals rather than ignoring it', () => {
    // the stat block hangs off the occupant vitals; silently dropping the
    // flag is the §3.13 silent-argument defect this whole vocabulary exists
    // to refuse
    expect(() => REGISTRY.node.parseArgs(['9', '--stats'])).toThrow(QueryError);
    expect(REGISTRY.node.parseArgs(['9', '--with-vitals', '--stats'])).toMatchObject({
      index: 9,
      withVitals: true,
      stats: true,
    });
    // and the attacker positional still parses with both flags present
    expect(REGISTRY.node.parseArgs(['9', '219', '--with-vitals', '--stats', '--full'])).toMatchObject({
      index: 9,
      attacker: 219,
      withVitals: true,
      stats: true,
      full: true,
    });
  });
});
