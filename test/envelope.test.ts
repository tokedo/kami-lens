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
