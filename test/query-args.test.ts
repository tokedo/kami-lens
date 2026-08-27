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
import {
  assertSocketArgs,
  CLIENT_FLAGS,
  QUERY_NAMES,
  REGISTRY,
  routeCliArgs,
} from '../src/queries/registry';

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

  // ------------------------------------------------------ 0.5.2 additions

  it('node --eligible-only refuses without --with-vitals AND without an attacker', () => {
    // the filter reads liquidation.eligible, which exists only on a vitals
    // answer that was given an attacker. Eligibility is a PAIRING, not a
    // property of the target, so an unfiltered answer is not a reasonable
    // fallback for a caller who asked for a filtered one.
    expect(() => REGISTRY.node.parseArgs(['9', '--eligible-only'])).toThrow(QueryError);
    expect(() => REGISTRY.node.parseArgs(['9', '--with-vitals', '--eligible-only'])).toThrow(
      QueryError
    );
    expect(
      REGISTRY.node.parseArgs(['9', '219', '--with-vitals', '--eligible-only'])
    ).toMatchObject({ index: 9, attacker: 219, withVitals: true, eligibleOnly: true });
  });

  it('node --eligible-only composes with --full and --stats', () => {
    expect(
      REGISTRY.node.parseArgs(['86', '15671', '--with-vitals', '--full', '--stats', '--eligible-only'])
    ).toMatchObject({
      index: 86,
      attacker: 15671,
      withVitals: true,
      full: true,
      stats: true,
      eligibleOnly: true,
    });
  });

  it('node without --eligible-only reports the flag as false, never undefined', () => {
    // the builder reads `args.eligibleOnly === true`; a missing key would
    // work today and break the day someone reads it as `!== false`
    expect(REGISTRY.node.parseArgs(['9'])).toMatchObject({ eligibleOnly: false });
  });

  it('account filters flags before taking the lookup key', () => {
    // THE 0.5.2 REGRESSION THIS EXISTS TO PIN. `account` was the one query
    // whose parser took argv[0] verbatim, because it had never declared an
    // argument. The moment it declared one, `account --slim` with no
    // positional would have looked up an account NAMED '--slim' and answered
    // NOT_FOUND — a different answer, silently, which is exactly what the
    // declared-argument vocabulary exists to refuse.
    expect(REGISTRY.account.parseArgs(['12', '--slim'])).toEqual({ index: 12, slim: true });
    expect(REGISTRY.account.parseArgs(['--slim', '12'])).toEqual({ index: 12, slim: true });
    expect(REGISTRY.account.parseArgs(['12'])).toEqual({ index: 12, slim: false });
  });

  it('account --slim works on all three lookup keys', () => {
    const addr = '0xb572C956Cf39DBd525360a25F3237450dc594Aa5';
    expect(REGISTRY.account.parseArgs(['BirthdayBoi', '--slim'])).toEqual({
      name: 'BirthdayBoi',
      slim: true,
    });
    expect(REGISTRY.account.parseArgs([addr, '--slim'])).toEqual({ address: addr, slim: true });
    expect(REGISTRY.account.parseArgs(['9', '--slim'])).toEqual({ index: 9, slim: true });
  });

  it('account still refuses with no lookup key at all', () => {
    expect(() => REGISTRY.account.parseArgs([])).toThrow(QueryError);
    // and a lone flag is not a key
    expect(() => REGISTRY.account.parseArgs(['--slim'])).toThrow(QueryError);
  });
});

// ---------------------------------------------------------------------------

describe('both entry points refuse an undeclared option (§3.13, 0.5.2)', () => {
  // THE DEFECT THIS PINS. The CLI has refused undeclared `--flags` since
  // 0.5.0; the SOCKET — the path the harness and the agents actually use —
  // silently ignored them. `account 3379 --slim` over the socket returned the
  // whole roster with `ok: true`, and `node … --eligible-only` returned an
  // unfiltered answer with `ok: true`, while the identical tokens on the CLI
  // were refused outright. A wrong-but-plausible answer to a question the
  // caller did not ask is worse than an error, and two entry points that
  // disagree about the same request is how it survived a release.

  const ALL = [...QUERY_NAMES, 'status'] as const;

  it('every query, on the SOCKET path', () => {
    for (const name of ALL) {
      expect(() => assertSocketArgs(name, ['--definitely-not-a-flag']), name).toThrow(QueryError);
      // and the refusal is BAD_ARGS, not something a caller reads as a miss
      try {
        assertSocketArgs(name, ['--definitely-not-a-flag']);
      } catch (e) {
        expect((e as QueryError).code, name).toBe('BAD_ARGS');
        expect((e as QueryError).message, name).toContain("unknown option '--definitely-not-a-flag'");
      }
    }
  });

  it('every query, on the CLI path', () => {
    for (const name of ALL) {
      expect(() => routeCliArgs(name, ['--definitely-not-a-flag']), name).toThrow(QueryError);
    }
  });

  it('every DECLARED argument is accepted on both paths', () => {
    for (const name of QUERY_NAMES) {
      for (const arg of REGISTRY[name].args ?? []) {
        expect(() => assertSocketArgs(name, [arg]), `${name} ${arg}`).not.toThrow();
        expect(routeCliArgs(name, [arg]).positional, `${name} ${arg}`).toContain(arg);
      }
    }
  });

  it('the socket refuses client flags as ARGUMENT tokens — they are request fields', () => {
    // the CLI strips these into request fields before sending, so over the
    // wire they are never argument tokens; a caller that puts one in `args`
    // was being ignored, which is the same defect in the other direction
    for (const flag of CLIENT_FLAGS) {
      expect(() => assertSocketArgs('kami', [flag])).toThrow(QueryError);
      // …while the CLI takes them on every query, as a client flag
      expect(routeCliArgs('kami', [flag]).flags.has(flag)).toBe(true);
    }
  });

  it('the two 0.5.2 flags are refused by the queries that do not declare them', () => {
    // the concrete pair from the field report
    expect(() => assertSocketArgs('account', ['3379', '--eligible-only'])).toThrow(QueryError);
    expect(() => assertSocketArgs('node', ['9', '--slim'])).toThrow(QueryError);
    // …and accepted by the ones that do
    expect(() => assertSocketArgs('account', ['3379', '--slim'])).not.toThrow();
    expect(() => assertSocketArgs('node', ['9', '219', '--with-vitals', '--eligible-only'])).not.toThrow();
  });

  it('an unknown QUERY name is not reported as a flag problem', () => {
    // precedence: the caller asked for a query that does not exist, and that
    // is the error worth telling them about
    expect(() => assertSocketArgs('nosuchquery', ['--whatever'])).not.toThrow();
    expect(() => routeCliArgs('nosuchquery', ['--whatever'])).not.toThrow();
  });

  it('positional arguments are never mistaken for options', () => {
    expect(() => assertSocketArgs('node', ['9', '219'])).not.toThrow();
    expect(routeCliArgs('node', ['9', '219']).positional).toEqual(['9', '219']);
  });
});
