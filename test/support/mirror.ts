// A small synthetic mirror for hermetic projection tests: a real recs world
// with the real component registry, populated by hand with the few entities a
// kami projection reads — the kami, its harvest, the node it sits on, and the
// config fields the harvest/rest math consumes. Nothing here is mocked: every
// query and getter the tests exercise is the shipped code reading real
// components.

import { createWorld, EntityIndex, removeComponent, setComponent, World } from 'engine/recs';
import { Components } from 'network/';
import { createComponents } from 'network/components';
import { hashArgs } from 'network/shapes/utils';

export type SyntheticMirror = {
  world: World;
  components: Components;
  blockNumber: number;
};

/** A stat as the chain packs it: base<<192 | shift<<128 | boost<<64 | sync. */
export const packStat = (base: number, shift = 0, boost = 0, sync = base): number => {
  const u = (n: number) => BigInt.asUintN(64, BigInt(n));
  const packed = (u(base) << 192n) | (u(shift) << 128n) | (u(boost) << 64n) | u(sync);
  // the decoder renders a uint256 as '0x' + bigint.toString(16)
  // (engine/encoders/decode.ts), and getStat reads it back through BigInt()
  return ('0x' + packed.toString(16)) as unknown as number;
};

/** A uint32[8] config array packed the way LibPack.packArrU32 packs it. */
export const packArray32 = (values: number[]): string => {
  let packed = 0n;
  for (const v of values) packed = (packed << 32n) | BigInt.asUintN(32, BigInt(v));
  return '0x' + packed.toString(16);
};

/** The live world's own kami config arrays, read with `config <name> --array`
 * on 2026-10-03 — and, as on the live world, NO `KAMI_REST_RECOVERY` field,
 * the one the ported getter reads that this world does not define. */
export const LIVE_KAMI_CONFIG: Record<string, number[]> = {
  KAMI_HARV_BOUNTY: [0, 9, 0, 0, 0, 0, 1000, 3],
  KAMI_HARV_EFFICACY_BODY: [3, 0, 650, 250, 0, 0, 0, 0],
  KAMI_HARV_EFFICACY_HAND: [3, 0, 350, 100, 0, 0, 0, 0],
  KAMI_HARV_FERTILITY: [0, 0, 1500, 3, 0, 0, 1000, 3],
  KAMI_HARV_INTENSITY: [5, 0, 480, 0, 0, 0, 10, 0],
  KAMI_HARV_STRAIN: [20, 0, 6500, 3, 0, 0, 1000, 3],
  KAMI_LIQ_ANIMOSITY: [0, 0, 400, 3, 0, 0, 0, 0],
  KAMI_LIQ_EFFICACY: [3, 0, 500, 500, 200, 0, 0, 0],
  KAMI_LIQ_THRESHOLD: [0, 3, 1000, 3, 0, 3, 0, 0],
  KAMI_LIQ_SALVAGE: [0, 2, 0, 3, 0, 0, 0, 0],
  KAMI_LIQ_SPOILS: [45, 2, 0, 3, 0, 0, 0, 0],
  KAMI_LIQ_KARMA: [0, 0, 2000, 3, 0, 0, 0, 0],
  KAMI_LIQ_RECOIL: [1000, 3, 0, 0, 0, 0, 1000, 3],
  KAMI_LIQ_KARMA_EFFICACY: [3, 0, 1000, 1000, 400, 0, 0, 0],
  KAMI_REST_METABOLISM: [20, 0, 600, 3, 0, 0, 1000, 3],
  KAMI_TREE_REQ: [0, 5, 15, 25, 40, 55, 75, 95],
  KAMI_LVL_REQ_MULT_BASE: [1259, 3, 0, 0, 0, 0, 0, 0],
};

/** The live world's scalar kami config values (`config <name>`, 2026-10-03). */
export const LIVE_KAMI_CONFIG_VALUES: Record<string, number> = {
  KAMI_STANDARD_COOLDOWN: 180,
  KAMI_LVL_REQ_BASE: 40,
};

/** Read by the ported getter, NOT defined by the live world. */
export const LIVE_KAMI_CONFIG_UNDEFINED = ['KAMI_REST_RECOVERY'];

export function makeMirror(
  blockNumber = 1_000,
  opts: { omitConfig?: string[] } = {}
): SyntheticMirror {
  const world = createWorld();
  const components = createComponents(world);
  const mirror = { world, components, blockNumber };
  // entity index 0 is falsy, and the ported getters read `if (!entity)` as
  // "absent" (network/shapes/Config/types.ts) — on the live world index 0 is
  // never a config or kami entity, so it is never one here either
  world.registerEntity({ id: '0x0' as never });
  const omit = new Set(opts.omitConfig ?? []);
  for (const [field, values] of Object.entries(LIVE_KAMI_CONFIG)) {
    if (omit.has(field)) continue;
    const id = hashArgs(['is.config', field], ['string', 'string']);
    const e = world.registerEntity({ id });
    setComponent(components.Value, e, { value: packArray32(values) as unknown as number });
  }
  for (const [field, value] of Object.entries(LIVE_KAMI_CONFIG_VALUES)) {
    if (omit.has(field)) continue;
    const id = hashArgs(['is.config', field], ['string', 'string']);
    const e = world.registerEntity({ id });
    setComponent(components.Value, e, { value: ('0x' + value.toString(16)) as unknown as number });
  }
  return mirror;
}

/** An item registry entry, as LibItem registers one: the entity at
 * hash("registry.item", index) with IsRegistry + ItemIndex + Name + Type.
 * Idempotent — a second call for the same index returns the first entity. */
export function addRegistryItem(
  m: SyntheticMirror,
  index: number,
  name: string,
  type = 'MISC'
): EntityIndex {
  const { world, components: c } = m;
  const id = hashArgs(['registry.item', index], ['string', 'uint32']);
  const existing = world.entityToIndex.get(id);
  if (existing !== undefined) return existing;
  const e = world.registerEntity({ id });
  setComponent(c.EntityType, e, { value: 'ITEM' });
  setComponent(c.IsRegistry, e, { value: true });
  setComponent(c.ItemIndex, e, { value: index });
  setComponent(c.Name, e, { value: name });
  setComponent(c.Type, e, { value: type });
  return e;
}

/** 1.1.0: what every node on the live world carries besides its identity —
 * a yield item (ItemIndex, resolved through the item registry), a scavenge
 * registry entry (Value = the tier cost, Affinity copied from the node), and,
 * for a node with a level limit, the condition the deploy writes for it:
 * (LEVEL, CURR_MAX, value = the limit, for KAMI) under the anchor
 * hash("node.requirement", index). `null` leaves a fact OUT, to model a
 * mirror that lacks it. */
export type NodeFacts = {
  /** yield item index (default 1); null = no ItemIndex on the node */
  item?: number | null;
  /** the registry name for `item` (default 'MUSU'); null = no registry entry */
  itemName?: string | null;
  /** scavenge tier cost (default 100); null = no scavenge registry entry */
  scavCost?: number | null;
  /** the node's affinity (default 'NORMAL'), copied onto the scavenge entry */
  affinity?: string;
  /** a level limit, written the way the deploy writes it */
  levelLimit?: number;
};

export function addNode(
  m: SyntheticMirror,
  index: number,
  name = `node ${index}`,
  facts: NodeFacts = {}
): EntityIndex {
  const { world, components } = m;
  const id = hashArgs(['node', index], ['string', 'uint32']);
  const e = world.registerEntity({ id });
  const affinity = facts.affinity ?? 'NORMAL';
  setComponent(components.EntityType, e, { value: 'NODE' });
  setComponent(components.NodeIndex, e, { value: index });
  setComponent(components.Name, e, { value: name });
  setComponent(components.Type, e, { value: 'NORMAL' });
  setComponent(components.Affinity, e, { value: affinity });
  setComponent(components.RoomIndex, e, { value: index });
  const item = facts.item === undefined ? 1 : facts.item;
  if (item !== null) {
    setComponent(components.ItemIndex, e, { value: item });
    const itemName = facts.itemName === undefined ? 'MUSU' : facts.itemName;
    if (itemName !== null) addRegistryItem(m, item, itemName);
  }
  const scavCost = facts.scavCost === undefined ? 100 : facts.scavCost;
  if (scavCost !== null) {
    const sid = hashArgs(['registry.scavenge', 'NODE', index], ['string', 'string', 'uint32']);
    const se = world.registerEntity({ id: sid });
    setComponent(components.EntityType, se, { value: 'SCAVENGE' });
    setComponent(components.IsRegistry, se, { value: true });
    setComponent(components.Type, se, { value: 'NODE' });
    setComponent(components.Index, se, { value: index });
    setComponent(components.Affinity, se, { value: affinity });
    // the decoder renders a uint256 as '0x' + hex (engine/encoders/decode.ts)
    setComponent(components.Value, se, { value: ('0x' + scavCost.toString(16)) as unknown as number });
  }
  if (facts.levelLimit !== undefined) {
    addNodeCondition(m, index, {
      type: 'LEVEL',
      logic: 'CURR_MAX',
      value: facts.levelLimit,
      for: 'KAMI',
    });
  }
  return e;
}

/** One CONDITION entity under a node's requirement anchor, as
 * LibConditional.createFor writes it: Type + LogicType always; Index, Value
 * and For only when non-zero / non-empty. */
export function addNodeCondition(
  m: SyntheticMirror,
  nodeIndex: number,
  con: { type: string; logic: string; index?: number; value?: number; for?: string },
  salt = 0
): EntityIndex {
  const { world, components: c } = m;
  const id = hashArgs(
    ['test.condition', nodeIndex, con.type, con.logic, salt],
    ['string', 'uint32', 'string', 'string', 'uint32']
  );
  const e = world.registerEntity({ id });
  setComponent(c.Type, e, { value: con.type });
  setComponent(c.LogicType, e, { value: con.logic });
  if (con.index) setComponent(c.Index, e, { value: con.index });
  if (con.value) setComponent(c.Value, e, { value: ('0x' + con.value.toString(16)) as unknown as number });
  if (con.for) setComponent(c.For, e, { value: con.for });
  setComponent(c.AnchorID, e, {
    value: hashArgs(['node.requirement', nodeIndex], ['string', 'uint32']),
  });
  return e;
}

export type KamiSpec = {
  index: number;
  state: 'RESTING' | 'HARVESTING' | 'DEAD';
  hp?: { base: number; sync: number };
  level?: number;
  experience?: number;
  /** chain seconds */
  lastTime: number;
  nextTime?: number;
  /** HARVESTING only: the node the harvest sits on */
  node?: number;
  /** HARVESTING only: false leaves the harvest entity out (the transient) */
  withHarvest?: boolean;
};

export function addKami(m: SyntheticMirror, spec: KamiSpec): EntityIndex {
  const { world, components: c } = m;
  const id = hashArgs(['kami.id', spec.index], ['string', 'uint32']);
  const e = world.registerEntity({ id });
  setComponent(c.EntityType, e, { value: 'KAMI' });
  setComponent(c.KamiIndex, e, { value: spec.index });
  setComponent(c.Name, e, { value: `kami ${spec.index}` });
  setComponent(c.MediaURI, e, { value: 'x' });
  setComponent(c.State, e, { value: spec.state });
  const hp = spec.hp ?? { base: 100, sync: 80 };
  setComponent(c.Health, e, { value: packStat(hp.base, 0, 0, hp.sync) });
  setComponent(c.Power, e, { value: packStat(20, 0, 0, 0) });
  setComponent(c.Violence, e, { value: packStat(15, 0, 0, 0) });
  setComponent(c.Harmony, e, { value: packStat(15, 0, 0, 0) });
  setComponent(c.Level, e, { value: spec.level ?? 12 });
  setComponent(c.Experience, e, { value: spec.experience ?? 5 });
  setComponent(c.LastTime, e, { value: spec.lastTime });
  setComponent(c.StartTime, e, { value: spec.lastTime });
  setComponent(c.NextTime, e, { value: spec.nextTime ?? spec.lastTime });
  if (spec.state === 'HARVESTING' && spec.withHarvest !== false) {
    const nodeIndex = spec.node ?? 1;
    const nodeId = hashArgs(['node', nodeIndex], ['string', 'uint32']);
    if (world.entityToIndex.get(nodeId) === undefined) addNode(m, nodeIndex);
    const hid = hashArgs(['harvest', id], ['string', 'uint256']);
    const h = world.registerEntity({ id: hid });
    setComponent(c.EntityType, h, { value: 'HARVEST' });
    setComponent(c.State, h, { value: 'ACTIVE' });
    setComponent(c.SourceID, h, { value: nodeId });
    setComponent(c.HolderID, h, { value: id });
    setComponent(c.LastTime, h, { value: spec.lastTime });
    setComponent(c.ResetTime, h, { value: spec.lastTime });
    setComponent(c.StartTime, h, { value: spec.lastTime });
    setComponent(c.Balance, h, { value: 0 });
  }
  return e;
}

/** Drop one component from an entity (to model a join the mirror lacks). */
export function drop(m: SyntheticMirror, entity: EntityIndex, name: keyof Components): void {
  removeComponent(m.components[name] as never, entity);
}

/** An account owning the given (already added) kamis — OwnsKamiID is the
 * kami -> account join. */
export function addAccount(m: SyntheticMirror, index: number, kamis: number[]): EntityIndex {
  const { world, components: c } = m;
  const id = hashArgs(['account', index], ['string', 'uint32']);
  const e = world.registerEntity({ id });
  setComponent(c.EntityType, e, { value: 'ACCOUNT' });
  setComponent(c.AccountIndex, e, { value: index });
  setComponent(c.Name, e, { value: `account ${index}` });
  setComponent(c.RoomIndex, e, { value: 1 });
  for (const k of kamis) {
    const ke = world.entityToIndex.get(hashArgs(['kami.id', k], ['string', 'uint32']))!;
    setComponent(c.OwnsKamiID, ke, { value: id });
  }
  return e;
}
