import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as clock from '../src/clock';
import { buildEnvelope, classifyPaths } from '../src/queries/envelope';
import { loadSchema, QUERY_NAMES } from '../src/queries/registry';
import { resetSyncHealth, syncHealth } from '../src/sync-health';

// DESIGN §3.10: the untrusted path list is DERIVED from (schema ×
// classification), authored-prose is never volunteered, name-free mode
// withholds authored-id with receipt.

describe('classifyPaths (§3.10 derivation)', () => {
  it('derives kami query classes from the checked-in schema', () => {
    const classes = classifyPaths(loadSchema('kami'));
    expect(classes.get('name')).toBe('authored-id');
    expect(classes.get('account.name')).toBe('authored-id');
    expect(classes.get('node.name')).toBe('registry');
    expect(classes.get('state')).toBe('system');
    expect(classes.get('hpRatePerHr')).toBe('system');
  });

  it('derives account bio as authored-prose and kami refs as authored-id', () => {
    const classes = classifyPaths(loadSchema('account'));
    expect(classes.get('bio')).toBe('authored-prose');
    expect(classes.get('kamis[].name')).toBe('authored-id');
    expect(classes.get('ownerAddress')).toBe('system');
  });

  it('falls back to authored-prose for unclassified strings', () => {
    const schema = {
      $ref: '#/$defs/Mystery',
      $defs: {
        Mystery: {
          type: 'object',
          properties: { surprise: { type: 'string' } },
        },
      },
    };
    expect(classifyPaths(schema).get('surprise')).toBe('authored-prose');
  });

  // 0.6.3: the walk compared `node.type === 'object'` against a bare
  // string, so a NULLABLE block — `type: ['object', 'null']`, which is how
  // `checkpoint` has been declared since 0.2.0 and `lastFullLoad` since
  // 0.6.2 — was never descended into, and every classification entry under
  // one was inert. Silent both ways: nothing was mis-listed, and nothing
  // was classified either, so a string under such a block took the
  // artifact's default without anyone choosing it.
  it('descends a NULLABLE object block and classifies the strings under it', () => {
    const schema = {
      $ref: '#/$defs/Top',
      $defs: {
        Top: {
          type: 'object',
          properties: { block: { $ref: '#/$defs/Nullable' } },
        },
        Nullable: {
          type: ['object', 'null'],
          properties: { tag: { type: 'string' }, note: { type: 'string' } },
        },
      },
    };
    const classes = classifyPaths(schema);
    // walked at all — before 0.6.3 the map was EMPTY for this schema
    expect([...classes.keys()]).toEqual(['block.tag', 'block.note']);
    // and the artifact's own classification is what decides the class
    expect(classes.get('block.tag')).toBe('authored-prose'); // unlisted → default
  });

  it('descends an anyOf whose other branch is null', () => {
    const schema = {
      $ref: '#/$defs/Top',
      $defs: {
        Top: {
          type: 'object',
          properties: {
            block: { anyOf: [{ type: 'object', properties: { tag: { type: 'string' } } }, { type: 'null' }] },
            list: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
          },
        },
      },
    };
    const classes = classifyPaths(schema);
    expect(classes.get('block.tag')).toBe('authored-prose');
    expect(classes.get('list[]')).toBe('authored-prose');
  });

  it('the real status schema classifies the strings under its nullable blocks', () => {
    const classes = classifyPaths(loadSchema('status'));
    // lastFullLoad is `type: ['object','null']`; its entries were declared
    // in 0.6.2 and never reached until the walk was fixed
    expect(classes.get('lastFullLoad.source')).toBe('system');
    expect(classes.get('lastFullLoad.prefix')).toBe('system');
    expect(classes.get('lastFullLoad.kind')).toBe('system');
    expect(classes.get('lastFullLoad.at')).toBe('system');
  });

  // Found BY the fix above, and pre-existing: neither of these was ever
  // classified, so both took the authored-prose default and were therefore
  // DELETED from a served answer with a receipt in `meta.suppressed` —
  // `config.stateCdnUrl` from every status answer since 0.6.2, and every
  // `feedsDegraded` entry since 0.5.2 whenever the array was non-empty. The
  // envelope and the derivation agreed, which is why G3.f passed: they were
  // consistently wrong. Both are machine-produced strings, so `system`.
  it('classifies every status string that a reader is meant to receive', () => {
    const classes = classifyPaths(loadSchema('status'));
    expect(classes.get('config.stateCdnUrl')).toBe('system');
    expect(classes.get('feedsDegraded[]')).toBe('system');
    // nothing in status may default: it is all daemon-produced text
    for (const [p, c] of classes) {
      expect(c, `status path ${p} is unclassified`).not.toBe('authored-prose');
    }
  });

  it('every query schema derives without error and lists only present classes', () => {
    for (const name of [...QUERY_NAMES, 'status', 'kami-stateless'] as const) {
      const classes = classifyPaths(loadSchema(name as never));
      for (const [, c] of classes) {
        expect(['authored-id', 'authored-prose', 'registry', 'system']).toContain(c);
      }
    }
  });
});

describe('buildEnvelope (§3.10 composition)', () => {
  const META = { blockNumber: 1, stale: false, mode: 'daemon' as const };

  it('tags present authored-id paths and nothing else', () => {
    const data = {
      id: '0x1',
      index: 1,
      name: 'Kamigotchi 1',
      state: 'RESTING',
      hp: { current: 1, total: 2, percent: 50 },
      hpRatePerHr: '+1.00',
      cooldownSec: 0,
      account: { index: 9, name: 'buzz' },
    };
    const env = buildEnvelope(data, loadSchema('kami'), META);
    expect(env.untrusted).toEqual(['account.name', 'name']);
    expect(env.data.name).toBe('Kamigotchi 1');
  });

  it('never volunteers authored-prose: prunes bio with receipt unless opted in', () => {
    const base = {
      id: '0x1',
      index: 1,
      name: 'buzz',
      ownerAddress: '0x0',
      operatorAddress: '0x0',
      roomIndex: 1,
      musu: 0,
      reputation: { agency: 0, mina: 0, nursery: 0 },
      kamis: [],
    };
    const pruned = buildEnvelope({ ...base, bio: 'hi' }, loadSchema('account'), META);
    expect((pruned.data as { bio?: string }).bio).toBeUndefined();
    expect(pruned.meta.suppressed).toEqual(['bio']);
    expect(pruned.untrusted).toEqual(['name']);

    const opted = buildEnvelope({ ...base, bio: 'hi' }, loadSchema('account'), META, {
      prose: true,
    });
    expect((opted.data as { bio?: string }).bio).toBe('hi');
    expect(opted.untrusted).toEqual(['bio', 'name']);
  });

  it('name-free mode withholds authored-id with receipt, keeps stable IDs', () => {
    const data = {
      id: '0x1',
      index: 1,
      name: 'Kamigotchi 1',
      state: 'RESTING',
      hp: { current: 1, total: 2, percent: 50 },
      hpRatePerHr: '+1.00',
      cooldownSec: 0,
      account: { index: 9, name: 'buzz' },
    };
    const env = buildEnvelope(data, loadSchema('kami'), META, { noAuthored: true });
    expect((env.data as { name?: string }).name).toBeUndefined();
    expect(env.data.account?.name).toBeUndefined();
    expect(env.data.id).toBe('0x1');
    expect(env.data.account?.index).toBe(9);
    expect(env.meta.suppressed).toEqual(['account.name', 'name']);
    expect(env.untrusted).toEqual([]);
  });

  // §3.12 payload enrichment (0.4.0). Every field the flag adds is a STRING
  // the fail-safe would otherwise resolve to authored-prose and DELETE from
  // the answer — so these assertions are what keeps the enriched surface
  // reachable at all, not decoration.
  it('classifies every enriched item field as registry game content', () => {
    const inv = classifyPaths(loadSchema('inventory'));
    expect(inv.get('items[].item.description')).toBe('registry');
    expect(inv.get('items[].item.effects.use[].entries[].name')).toBe('registry');
    expect(inv.get('items[].item.effects.use[].entries[].description')).toBe('registry');
    expect(inv.get('items[].item.effects.equip[].entries[].description')).toBe('registry');
    expect(inv.get('items[].item.requirements[].text')).toBe('registry');
    // the raw allo/condition facts beside the text are enum-ish system labels
    expect(inv.get('items[].item.effects.use[].type')).toBe('system');
    expect(inv.get('items[].item.requirements[].type')).toBe('system');
  });

  it('classifies enriched quest rewards, objective refs and room refs', () => {
    const quests = classifyPaths(loadSchema('quests'));
    expect(quests.get('registry[].rewards[].entries[].name')).toBe('registry');
    expect(quests.get('registry[].rewards[].entries[].description')).toBe('registry');
    expect(quests.get('registry[].rewards[].type')).toBe('system');
    expect(quests.get('registry[].account.objectives[].room.name')).toBe('registry');
    expect(quests.get('registry[].account.objectives[].item.description')).toBe('registry');

    for (const [query, path] of [
      ['account', 'room.description'],
      ['node', 'room.description'],
      ['roster', 'account.room.name'],
      ['trades', 'open[].buyOrder.items[].description'],
      ['auctions', 'auctions[].auctionItem.description'],
      ['merchant', 'listings[].payItem.description'],
    ] as const) {
      expect(classifyPaths(loadSchema(query)).get(path)).toBe('registry');
    }
  });

  it('keeps enriched fields in the answer and off the untrusted list', () => {
    const data = {
      account: { index: 9, name: 'buzz' },
      items: [
        {
          balance: 2,
          item: {
            id: '0x1',
            index: 11204,
            name: 'Ambrosia',
            type: 'FOOD',
            description: 'A honeyed draught.',
            effects: {
              use: [
                {
                  type: 'XP',
                  index: 0,
                  value: 1000,
                  entries: [{ name: 'XP', description: '+1000 XP' }],
                },
              ],
              equip: [],
            },
            requirements: [
              { type: 'KAMI_CAN_EAT', index: 0, value: 0, text: 'None' },
            ],
          },
        },
      ],
    };
    const env = buildEnvelope(data, loadSchema('inventory'), META);
    const row = env.data.items[0].item;
    expect(row.description).toBe('A honeyed draught.');
    expect(row.effects.use[0].entries[0].description).toBe('+1000 XP');
    expect(row.requirements[0].text).toBe('None');
    // registry class: never volunteered-prose, never a name — the only
    // authored string in an enriched inventory answer is the account name
    expect(env.untrusted).toEqual(['account.name']);
    expect(env.meta.suppressed).toBeUndefined();
  });

  it('an enriched roster still carries no authored string at all', () => {
    const data = {
      account: { index: 9, roomIndex: 12, room: { index: 12, name: 'Scrap Confluence' } },
      kamis: [{ index: 1, state: 'RESTING', hp: [10, 20] }],
    };
    const env = buildEnvelope(structuredClone(data), loadSchema('roster'), META);
    expect(env.untrusted).toEqual([]);
    const nameFree = buildEnvelope(structuredClone(data), loadSchema('roster'), META, {
      noAuthored: true,
    });
    // byte-identical in name-free mode: a room NAME is registry content, not
    // an authored id, so there is nothing to withhold and no receipt to raise
    expect(JSON.stringify(nameFree.data)).toBe(JSON.stringify(data));
    expect(nameFree.meta.suppressed).toBeUndefined();
    expect(nameFree.untrusted).toEqual([]);
  });

  it('does not claim schema paths absent from the data', () => {
    const data = {
      id: '0x1',
      index: 1,
      name: 'K',
      state: 'RESTING',
      hp: { current: 1, total: 2, percent: 50 },
      hpRatePerHr: '+1.00',
      cooldownSec: 0,
    };
    const env = buildEnvelope(data, loadSchema('kami'), META);
    expect(env.untrusted).toEqual(['name']); // no account/node present
  });
});

// --- §3.15 / §3.8: the envelope's META, which has no JSON schema ------------
//
// 0.6.1 note, and the reason this block exists at all: the checked-in schemas
// under src/queries/schemas/ describe `data` ONLY, and every gate validates
// `envelope.data`. Nothing anywhere machine-checks the shape of `meta`, so a
// field added to it — or one silently dropped — would reach consumers with no
// enforcement whatsoever. These assertions plus the G3.f meta check are that
// enforcement.

describe('meta.reconciledThrough (§3.15, 0.6.1)', () => {
  const META = { blockNumber: 7, stale: false, mode: 'daemon' as const };
  const DATA = { rooms: [] };

  beforeEach(() => {
    resetSyncHealth();
    clock.reset();
  });
  afterEach(() => {
    resetSyncHealth();
    clock.reset();
  });

  it('is present on every answer and is null before the baseline is seeded', () => {
    const env = buildEnvelope(structuredClone(DATA), loadSchema('room'), META);
    expect('reconciledThrough' in env.meta).toBe(true);
    expect(env.meta.reconciledThrough).toBeNull();
  });

  it('carries the verified lower bound once the sync layer has one', () => {
    syncHealth.reconciledThrough = 32_990_374;
    const env = buildEnvelope(structuredClone(DATA), loadSchema('room'), META);
    expect(env.meta.reconciledThrough).toBe(32_990_374);
  });

  it('is null — never 0 — on a path with no sync worker (the stateless CLI)', () => {
    // src/cli.ts builds an envelope in `mode: 'stateless'` from a process that
    // never starts a sync worker, so syncHealth stays at its initial value.
    // Null there means "this process verified nothing"; a 0 would read as
    // "verified through block 0", which is the §3.14 lie this repo refuses.
    const env = buildEnvelope(structuredClone(DATA), loadSchema('room'), {
      blockNumber: 7,
      stale: false,
      mode: 'stateless',
    });
    expect(env.meta.reconciledThrough).toBeNull();
    expect(env.meta.reconciledThrough).not.toBe(0);
  });

  it('is independent of meta.blockNumber — the two are different facts', () => {
    syncHealth.reconciledThrough = 100;
    const env = buildEnvelope(structuredClone(DATA), loadSchema('room'), {
      blockNumber: 12_345,
      stale: false,
      mode: 'daemon',
    });
    expect(env.meta.blockNumber).toBe(12_345);
    expect(env.meta.reconciledThrough).toBe(100);
  });

  it('every registry query stamps it, not just the one sampled above', () => {
    syncHealth.reconciledThrough = 42;
    for (const name of ['status', 'kami-stateless'] as const) {
      const env = buildEnvelope({}, loadSchema(name as never), META);
      expect(env.meta.reconciledThrough).toBe(42);
    }
  });

  it('the full meta key set is exactly what the contract names', () => {
    const env = buildEnvelope(structuredClone(DATA), loadSchema('room'), META);
    expect(Object.keys(env.meta).sort()).toEqual(
      ['asOf', 'blockNumber', 'mode', 'reconciledThrough', 'servedAt', 'stale'].sort()
    );
  });
});

// --- §3.8: the clock sample, renamed, with one release of aliases ----------

describe('meta.asOf clock-sample fields (§3.8, renamed 0.6.1)', () => {
  const META = { blockNumber: 7, stale: false, mode: 'daemon' as const };
  const DATA = { rooms: [] };
  const asOfOf = () => buildEnvelope(structuredClone(DATA), loadSchema('room'), META).meta.asOf;

  const NEW_NAMES = ['clockSampleBlock', 'clockSampleBlockTime', 'clockSampleAgoMs'] as const;
  const OLD_NAMES = ['observedBlock', 'observedBlockTime', 'observedAgoMs'] as const;

  beforeEach(() => {
    resetSyncHealth();
    clock.reset();
  });
  afterEach(() => {
    resetSyncHealth();
    clock.reset();
  });

  it('serves the new names once a clock observation exists', () => {
    clock.observeBlockTimestamp(1_755_000_000, 32_000_123);
    const asOf = asOfOf();
    expect(asOf.clockSampleBlock).toBe(32_000_123);
    expect(asOf.clockSampleBlockTime).toBe(1_755_000_000);
    expect(typeof asOf.clockSampleAgoMs).toBe('number');
    expect(asOf.clockSampleAgoMs).toBeGreaterThanOrEqual(0);
  });

  it('the deprecated aliases carry values EQUAL to the fields they mirror', () => {
    clock.observeBlockTimestamp(1_755_000_000, 32_000_123);
    const asOf = asOfOf();
    expect(asOf.observedBlock).toBe(asOf.clockSampleBlock);
    expect(asOf.observedBlockTime).toBe(asOf.clockSampleBlockTime);
    expect(asOf.observedAgoMs).toBe(asOf.clockSampleAgoMs);
  });

  it('the aliases are equal across repeated builds, not merely on the first', () => {
    clock.observeBlockTimestamp(1_754_000_000, 31_000_001);
    for (let i = 0; i < 5; i++) {
      const asOf = asOfOf();
      expect(asOf.observedBlock).toBe(asOf.clockSampleBlock);
      expect(asOf.observedBlockTime).toBe(asOf.clockSampleBlockTime);
      // the ago-value moves between builds; the invariant is that the pair
      // agrees WITHIN a build — one measurement, emitted twice
      expect(asOf.observedAgoMs).toBe(asOf.clockSampleAgoMs);
    }
  });

  it('all seven travel together: present together after an observation', () => {
    clock.observeBlockTimestamp(1_755_000_000, 32_000_123);
    const asOf = asOfOf() as Record<string, unknown>;
    const present = [...NEW_NAMES, ...OLD_NAMES, 'clockOffsetMs'].filter((k) => k in asOf);
    expect(present).toHaveLength(7);
  });

  it('all seven travel together: absent together before the first observation', () => {
    const asOf = asOfOf() as Record<string, unknown>;
    const present = [...NEW_NAMES, ...OLD_NAMES, 'clockOffsetMs'].filter((k) => k in asOf);
    expect(present).toEqual([]);
    // §3.14: a served clockOffsetMs of 0 would read as a measurement
    expect(asOf.clockOffsetMs).toBeUndefined();
    expect(Object.keys(asOf).sort()).toEqual(['block', 'projectedAtSec']);
  });

  it('block and clockSampleBlock are different facts and are not fused', () => {
    clock.observeBlockTimestamp(1_755_000_000, 31_999_000);
    const asOf = buildEnvelope(structuredClone(DATA), loadSchema('room'), {
      blockNumber: 32_000_500,
      stale: false,
      mode: 'daemon',
    }).meta.asOf;
    expect(asOf.block).toBe(32_000_500);
    expect(asOf.clockSampleBlock).toBe(31_999_000);
    expect(asOf.block).not.toBe(asOf.clockSampleBlock);
  });

  it('a clock observation that names no block reports 0, on both names', () => {
    clock.observeBlockTimestamp(1_755_000_000); // the stream tap names none
    const asOf = asOfOf();
    expect(asOf.clockSampleBlock).toBe(0);
    expect(asOf.observedBlock).toBe(0);
  });
});
