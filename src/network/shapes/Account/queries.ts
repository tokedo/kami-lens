/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/shapes/Account/queries.ts
 * changes:  two fixes to the entity-resolution caches (SPEC §4.2, "account
 *           lookup by name and by owner"). (1) queryByName and queryByOwner
 *           cached only when MORE THAN ONE entity matched (`length > 1`), so
 *           the ordinary case of exactly one match was never cached and the
 *           function returned the cache miss — `undefined` — every time; both
 *           now use `length > 0`, which is what queryByIndex and
 *           queryByOperator alongside them already do. (2) queryByOwner
 *           matched the raw address string against a component the mirror
 *           stores in MUD's normalised form, so it matched nothing at all; it
 *           now formats the address first, exactly as queryByOperator does
 *           (upstream's own TODO on this function asks for it). Bodies
 *           otherwise verbatim.
 */

import { EntityIndex, HasValue, QueryFragment, runQuery, World } from 'engine/recs';

import { formatEntityID } from 'engine/utils';
import { Components, NetworkLayer } from 'network/';
import { getKamiOwnerID } from '../utils/component';

export type QueryOptions = {
  index?: number;
  name?: string;
  operator?: string;
  owner?: string;
  room?: number;
};

// account entity querying caches on (relatively) static fields
export const IndexCache = new Map<number, EntityIndex>(); // account index to entity index
export const NameCache = new Map<string, EntityIndex>(); // account name to entity index
export const OperatorCache = new Map<string, EntityIndex>(); // account operator to entity index
export const OwnerCache = new Map<string, EntityIndex>(); // account owner to entity index

// query Account entities generally with query options. return matching entity indices
const query = (comps: Components, options?: QueryOptions): EntityIndex[] => {
  const { AccountIndex, EntityType, Name, OwnerAddress, OperatorAddress, RoomIndex } = comps;

  const toQuery: QueryFragment[] = [];
  if (options?.index) toQuery.push(HasValue(AccountIndex, { value: options.index }));
  if (options?.owner) toQuery.push(HasValue(OwnerAddress, { value: options.owner }));
  if (options?.operator) toQuery.push(HasValue(OperatorAddress, { value: options.operator }));
  if (options?.name) toQuery.push(HasValue(Name, { value: options.name }));
  if (options?.room) toQuery.push(HasValue(RoomIndex, { value: options.room }));
  toQuery.push(HasValue(EntityType, { value: 'ACCOUNT' })); // last bc fat

  const results = runQuery(toQuery);
  return Array.from(results);
};

// query for all account entities
export const queryAll = (comps: Components) => {
  return query(comps);
};

// query for an account entity by its index
export const queryByIndex = (comps: Components, index: number) => {
  if (!IndexCache.has(index)) {
    const results = query(comps, { index });
    const length = results.length;
    if (length != 1) console.warn(`found ${length} entities for account index: ${index}`);
    if (length > 0) IndexCache.set(index, results[0]);
  }
  return IndexCache.get(index);
};

// query for an account entity by its name
export const queryByName = (comps: Components, name: string) => {
  if (!NameCache.has(name)) {
    const results = query(comps, { name });
    const length = results.length;
    if (length != 1) console.warn(`found ${length} entities for account name: ${name}`);
    // `> 0`, not upstream's `> 1`: one match is the NORMAL case, and refusing
    // to cache it made this function return undefined for every uniquely
    // named account — i.e. every real one (§4.2)
    if (length > 0) NameCache.set(name, results[0]);
  }
  return NameCache.get(name);
};

// query for an account entity by its attached operator address
// NOTE: we format to match MUD's abbreviated style. fix, eventually
export const queryByOperator = (comps: Components, operator: string, debug = false) => {
  if (!OperatorCache.has(operator)) {
    const formatted = formatEntityID(operator);
    const results = query(comps, { operator: formatted });

    // report on multiple matches if in debug mode
    // NOTE: there has to be a better way to do this..
    const length = results.length;
    if (debug && length != 1) {
      console.warn(`found ${length} entities for account operator: ${operator}`);
    }

    const result = results[0];
    if (length > 0 && result != 0) OperatorCache.set(operator, result);
  }

  return OperatorCache.get(operator);
};

// query for an account entity by its owner address
// todo: query directly! accID = formatEntityID(ownerAddr)
export const queryByOwner = (comps: Components, owner: string) => {
  if (!OwnerCache.has(owner)) {
    // format first (§4.2): the mirror stores this component in MUD's
    // normalised form — lower-cased, and with the leading zero of an odd
    // nibble dropped — so a raw-string match finds nothing whatever the
    // caller passes. queryByOperator has always done this; the TODO above
    // asks for it here.
    const formatted = formatEntityID(owner);
    const results = query(comps, { owner: formatted });
    const length = results.length;
    if (length != 1) console.warn(`found ${length} entities for account owner: ${owner}`);
    // `> 0`, not upstream's `> 1` — see queryByName
    if (length > 0) OwnerCache.set(owner, results[0]);
  }
  return OwnerCache.get(owner);
};

// query for account entities by a room index
export const queryAllByRoom = (comps: Components, room: number) => {
  const results = query(comps, { room });
  return results;
};

// query an Account entity that owns a Kami (by entity)
export const queryForKami = (
  world: World,
  comps: Components,
  kamiEntity: EntityIndex
): EntityIndex | undefined => {
  if (!kamiEntity) return;
  const id = getKamiOwnerID(comps, kamiEntity);
  return world.entityToIndex.get(id);
};

/////////////////
// UTILS
// NOTE: these are functions built on top of actual query functions
// possibly move them elsewhere

// quuery for an account from the burner attached to the network layer
export const queryFromEmbedded = (network: NetworkLayer): EntityIndex => {
  const { components } = network;
  const connectedAddress = network.network.connectedAddress.get() ?? '';
  const result = queryByOperator(components, connectedAddress);
  return (result ?? 0) as EntityIndex;
};
