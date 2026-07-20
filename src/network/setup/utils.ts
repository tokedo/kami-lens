/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/setup/utils.ts
 * changes:  tripwire counter (DESIGN §7) at the existing unknown-component
 *           warn site in applyNetworkUpdates: a stream event whose
 *           componentId has no registry mapping increments
 *           tripwires.unknownComponentIds (the EmptyNetworkEvent
 *           heartbeat is excluded, as upstream's guard already does).
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

  // Send "ack" to tell the sync worker we're ready to receive events while not processing
  let processing = false;
  const ackSub = timer(0, 100)
    .pipe(
      filter(() => !processing),
      map(() => ack)
    )
    .subscribe(ack$);

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
          if (update.txHash !== 'EmptyNetworkEvent') {
            tripwires.unknownComponentIds++;
            log.warn('Unknown component:', update.component);
          }
          continue;
        }

        if (update.value === undefined) {
          // undefined value means component removed
          removeComponent(component as Component<Schema>, entity);
        } else {
          setComponent(component as Component<Schema>, entity, update.value);
        }
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
