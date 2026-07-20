/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/create.ts
 * changes:  swap point 2 (DESIGN §4.1) — upstream spawns Sync.worker.ts as a
 *           browser web worker and bridges it with postMessage streams; the
 *           port constructs SyncWorker in-process and wires the same RxJS
 *           streams directly (identical Input/NetworkEvent[] contract,
 *           identical ack cadence). Swap point 5 — the tab-visibility wake
 *           handler (createVisibilityHandler) is deleted; the stream's own
 *           timeout/retry loop covers liveness for a daemon. The public
 *           shape { ecsEvents$, input$, dispose } is unchanged.
 */

import { Components } from 'engine/recs';
import { map, Observable, Subject, Subscription, timer } from 'rxjs';

import { SyncWorker } from './sync/Worker';
import { Ack, ack, Input } from './sync/Worker';
import { NetworkEvent } from './types';

/**
 * Create a new SyncWorker (in-process) to perform contract/client state sync.
 * The caller and worker communicate via RxJS streams.
 *
 * @returns Object {
 * ecsEvents$: Stream of network component updates synced by the SyncWorker,
 * input$: RxJS subject to pass in config for the SyncWorker,
 * dispose: function to dispose of the sync worker
 * }
 */
export function createSyncWorker<C extends Components>(ack$?: Observable<Ack>) {
  const input$ = new Subject<Input>();
  const worker = new SyncWorker<C>();
  const ecsEvents$ = new Subject<NetworkEvent<C>[]>();

  // Send ack every 16ms if no external ack$ is provided
  ack$ = ack$ || timer(0, 16).pipe(map(() => ack));
  const ackSub = ack$.subscribe(input$);

  // Pass in a "config stream", receive a stream of ECS events
  const subscription: Subscription = worker.work(input$).subscribe(ecsEvents$);

  const dispose = () => {
    subscription?.unsubscribe();
    ackSub?.unsubscribe();
    worker.dispose();
  };

  return {
    ecsEvents$,
    input$,
    dispose,
  };
}
