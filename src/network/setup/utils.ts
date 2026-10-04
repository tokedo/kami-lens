/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/network/setup/utils.ts
 * changes:  tripwire counter (DESIGN §7) at the existing unknown-component
 *           warn site in applyNetworkUpdates: a stream event whose
 *           componentId has no registry mapping increments
 *           tripwires.unknownComponentIds (the EmptyNetworkEvent
 *           heartbeat is excluded, as upstream's guard already does).
 *           1.0.0 (A2(c)), THE ORDERING GUARD: applyNetworkUpdates is the one
 *           place stream frames, gap heals, the reconcile, the bootstrap fill
 *           and the state cache all land, and upstream wrote every update it
 *           was handed, in arrival order. A chain re-read that came back
 *           short therefore RESTORED a range's older writes (a harvest
 *           start) over newer ones the stream had applied (its stop). So the
 *           apply path remembers, per (component, entity), where the last
 *           write applied came from, and refuses an older one.
 *           1.0.1, THE RULE CORRECTED (field report 2026-10-04): 1.0.0
 *           remembered (block, logIndex) and refused anything not strictly
 *           newer. On Yominet a log's index restarts in every TRANSACTION (a
 *           real five-transaction block: 44 World logs indexed 1..16, then
 *           1..7 four times — 16 distinct indices), and a stream frame
 *           carries no transaction index — so a later transaction's write
 *           with an equal or lower index was refused as "older", on the
 *           stream and again on every re-read of the block (its collapsed
 *           newest write has the same small index): in that block every key
 *           written by more than one transaction (7 of 16) was left on a
 *           non-final write. The rule now never compares log indices. Per key
 *           it keeps the BLOCK of the last write applied and whether that
 *           write was the block's FINAL one (`final`: set only on a proven,
 *           collapsed chain read — workers/sync/stream/heal.ts). An update of
 *           block B is skipped iff the key holds a write of a later block, or
 *           B's final write; otherwise it is applied and the key records (B,
 *           update.final). So: inside one block the stream's arrival order is
 *           the truth (I1); a chain read's final write is applied unless
 *           something at least as new is there (I2); after it, no write of
 *           its block or an earlier one lands (I3). Removals record their
 *           place too, so an older set cannot bring a removed value back. An
 *           update with NO position (state-cache entries, Kamigaze diff
 *           events) applies unconditionally and forgets the key's place; the
 *           stream's frontier rule keeps an older chain write from landing on
 *           such a value. When reconciledThrough advances to R, places in
 *           blocks BELOW R are forgotten — every later write of those blocks
 *           is a re-read of a complete block, never a newer write. R's own
 *           block is kept: the reconcile may prove R while the stream is
 *           still inside it, and the rest of R's frames must still meet R's
 *           final write (1.0.0 forgot R too).
 *           1.0.1, THE REPAIR TRIPWIRE: a block-final write the guard applies
 *           that carries `reconcileCursor` (the periodic reconcile's, stamped in
 *           stream.ts) is a REPAIR when its block is strictly below that
 *           cursor and it changes the mirror's value (sameComponentValue):
 *           counted in syncHealth.reconcileRepairs, one WARN line each.
 *           1.0.0 (A5): after each update it acts on that update's
 *           AppliedMark, which is how appliedThrough and reconciledThrough
 *           move only once the writes they vouch for are in the mirror.
 *           Everything else verbatim.
 */

import {
  Component,
  Components,
  getComponentValue,
  removeComponent,
  Schema,
  setComponent,
  Type,
  World,
} from 'engine/recs';
import { Contract } from 'ethers';
import { compact } from 'lodash';
import { filter, map, Observable, Subject, timer } from 'rxjs';

import { Mappings } from 'engine/types';
import { formatEntityID } from 'engine/utils';
import { log } from 'utils/logger';
import { Ack, ack } from 'workers/sync';

import { tripwires } from '../../tripwires';
import { applyMark, recordRepair, syncHealth } from '../../sync-health';
import {
  isNetworkComponentUpdateEvent,
  isSystemCallEvent,
  NetworkComponentUpdate,
  NetworkEvent,
  SystemCall,
} from 'workers/types';
import { DecodedNetworkComponentUpdate, DecodedSystemCall } from './types';

export function createDecodeNetworkComponentUpdate<C extends Components>(
  world: World,
  components: C,
  mappings: Mappings<C>
): (update: NetworkComponentUpdate) => DecodedNetworkComponentUpdate | undefined {
  return (update: NetworkComponentUpdate) => {
    const entity =
      world.entityToIndex.get(update.entity) ?? world.registerEntity({ id: update.entity });
    const componentKey = mappings[update.component];
    if (!componentKey) {
      console.error(`
        Component mapping not found for component ID 
        ${update.component} ${JSON.stringify(update.value)}
      `);
      return undefined;
    }

    return {
      ...update,
      entity,
      component: components[componentKey] as Component<Schema>,
    };
  };
}

export function createSystemCallStreams<
  C extends Components,
  SystemTypes extends { [key: string]: Contract },
>(
  world: World,
  systemNames: string[],
  systemsRegistry: Component<{ value: Type.String }>,
  getSystemContract: (systemId: string) => { name: string; contract: Contract },
  decodeNetworkComponentUpdate: ReturnType<typeof createDecodeNetworkComponentUpdate>
) {
  const systemCallStreams = systemNames.reduce(
    (streams, systemId) => ({
      ...streams,
      [systemId]: new Subject<DecodedSystemCall<SystemTypes>>(),
    }),
    {} as Record<string, Subject<DecodedSystemCall<SystemTypes, C>>>
  );

  return {
    systemCallStreams,
    decodeAndEmitSystemCall: (systemCall: SystemCall<C>) => {
      const { tx } = systemCall;

      const systemEntityIndex = world.entityToIndex.get(formatEntityID(tx.to));
      if (systemEntityIndex === undefined) return;

      const hashedSystemId = getComponentValue(systemsRegistry, systemEntityIndex)?.value;
      if (hashedSystemId === undefined) return;

      const { name, contract } = getSystemContract(hashedSystemId);

      const decodedTx = contract.interface.parseTransaction({ data: tx.data, value: tx.value });

      // If this is a newly registered System make a new Subject
      if (!systemCallStreams[name]) {
        systemCallStreams[name] = new Subject<DecodedSystemCall<SystemTypes>>();
      }

      const rawUpdates = Array.isArray((systemCall as any).updates)
        ? ((systemCall as any).updates as NetworkComponentUpdate[])
        : [];

      systemCallStreams[name].next({
        ...systemCall,
        updates: compact(rawUpdates.map(decodeNetworkComponentUpdate)),
        systemId: name,
        args: decodedTx?.args ?? {},
      });
    },
  };
}

/** Exact equality of two component values (1.0.1, the repair tripwire): the
 * shapes the decoder produces — numbers, strings, booleans, bigints, arrays
 * of them, multi-key objects — and absent (undefined = never set / removed).
 * No coercion: 1, '1' and 1n are three different values. A key absent on one
 * side equals an undefined one on the other. */
export function sameComponentValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aList = Array.isArray(a) || ArrayBuffer.isView(a);
  const bList = Array.isArray(b) || ArrayBuffer.isView(b);
  if (aList || bList) {
    if (!aList || !bList) return false;
    const x = a as ArrayLike<unknown>;
    const y = b as ArrayLike<unknown>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!sameComponentValue(x[i], y[i])) return false;
    return true;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!sameComponentValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/** A short, bigint-safe rendering of a value for the repair WARN line. */
const preview = (v: unknown): string => {
  if (v === undefined) return 'absent';
  const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

/**
 * Sets up synchronization between contract components and client components
 */
export function applyNetworkUpdates<C extends Components>(
  world: World,
  components: C,
  ecsEvents$: Observable<NetworkEvent<C>[]>,
  mappings: Mappings<C>,
  ack$: Subject<Ack>,
  decodeAndEmitSystemCall?: (event: SystemCall<C>) => void
) {
  const txReduced$ = new Subject<string>();

  // 1.0.0 (A2(c)), rule corrected in 1.0.1 (see the banner): where the last
  // write applied per (component, entity) came from. The key is numeric
  // (component slot * 2^26 + entity index); the value packs that write's
  // BLOCK and whether it was the block's FINAL write: block * 2 + (final ? 1
  // : 0). Never a log index — on Yominet it restarts in every transaction.
  const lastPos = new Map<number, number>();
  const placeOf = (block: number, final: boolean): number => block * 2 + (final ? 1 : 0);
  const blockOf = (place: number): number => Math.floor(place / 2);
  const isFinal = (place: number): boolean => place % 2 === 1;
  const slotOf = new Map<string, number>();
  const keyOf = (componentKey: string, entity: number): number => {
    let slot = slotOf.get(componentKey);
    if (slot === undefined) {
      slot = slotOf.size;
      slotOf.set(componentKey, slot);
    }
    return slot * 2 ** 26 + entity;
  };
  // forget the places of blocks BELOW reconciledThrough; its own block stays
  // (the stream may still be inside it — see the banner)
  const prune = (through: number) => {
    for (const [k, place] of lastPos) if (blockOf(place) < through) lastPos.delete(k);
  };

  // Send "ack" to tell the sync worker we're ready to receive events while not processing
  let processing = false;
  const ackSub = timer(0, 100)
    .pipe(
      filter(() => !processing),
      map(() => ack)
    )
    .subscribe(ack$);

  const settleMark = (mark: NonNullable<NetworkComponentUpdate['appliedMark']>) => {
    if (applyMark(mark).reconciledAdvanced && syncHealth.reconciledThrough !== null) {
      prune(syncHealth.reconciledThrough);
    }
  };

  const delayQueueSub = ecsEvents$.subscribe((updates) => {
    processing = true;
    for (const update of updates) {
      if (isNetworkComponentUpdateEvent<C>(update)) {
        if (update.lastEventInTx) txReduced$.next(update.txHash);

        const entity =
          world.entityToIndex.get(update.entity) ?? world.registerEntity({ id: update.entity });
        const componentKey = mappings[update.component];
        const component = componentKey ? components[componentKey] : undefined;

        if (!component) {
          // 1.0.0 (A5): a marker update carries no write, only its mark
          if (update.appliedMark) {
            settleMark(update.appliedMark);
            continue;
          }
          if (update.txHash !== 'EmptyNetworkEvent') {
            tripwires.unknownComponentIds++;
            log.warn('Unknown component:', update.component);
          }
          continue;
        }

        // 1.0.0 (A2(c)), 1.0.1 rule: never let an older write overwrite a
        // newer one. An update with a logIndex came from a chain log (a
        // stream frame or a range read), so its blockNumber is that log's
        // real block; the index itself is not compared (see the banner).
        const key = keyOf(componentKey as string, entity);
        if (update.logIndex !== undefined) {
          const block = update.blockNumber;
          const last = lastPos.get(key);
          if (
            last !== undefined &&
            (blockOf(last) > block || (blockOf(last) === block && isFinal(last)))
          ) {
            syncHealth.olderWritesSkipped++;
            if (update.appliedMark) settleMark(update.appliedMark);
            continue;
          }
          lastPos.set(key, placeOf(block, update.final === true));
        } else {
          lastPos.delete(key);
        }

        // 1.0.1, the repair tripwire: a periodic-reconcile write the guard
        // let through, for a block the stream had already moved past when
        // the pass started, that changes what the mirror holds
        if (
          update.reconcileCursor !== undefined &&
          update.final === true &&
          update.blockNumber < update.reconcileCursor
        ) {
          const before = getComponentValue(component as Component<Schema>, entity);
          if (!sameComponentValue(before, update.value)) {
            recordRepair({
              block: update.blockNumber,
              component: componentKey as string,
              entity: update.entity,
            });
            log.warn(
              `[apply] reconcile REPAIRED ${componentKey as string} ${update.entity} at block ` +
                `${update.blockNumber} (stream cursor ${update.reconcileCursor} when the pass ` +
                `started): the mirror held ${preview(before)}, the chain's final write is ` +
                `${preview(update.value)} — a write the stream path did not apply`
            );
          }
        }

        if (update.value === undefined) {
          // undefined value means component removed
          removeComponent(component as Component<Schema>, entity);
        } else {
          setComponent(component as Component<Schema>, entity, update.value);
        }
        if (update.appliedMark) settleMark(update.appliedMark);
      } else if (decodeAndEmitSystemCall && isSystemCallEvent(update)) {
        decodeAndEmitSystemCall(update);
      }
    }
    // Send "ack" after every processed batch of events to process faster than ever 100ms
    ack$.next(ack);
    processing = false;
  });

  world.registerDisposer(() => {
    delayQueueSub?.unsubscribe();
    ackSub?.unsubscribe();
  });
  return { txReduced$: txReduced$.asObservable() };
}
