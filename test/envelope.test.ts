import { describe, expect, it } from 'vitest';

import { buildEnvelope, classifyPaths } from '../src/queries/envelope';
import { loadSchema, QUERY_NAMES } from '../src/queries/registry';

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
