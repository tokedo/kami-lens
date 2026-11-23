/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/workers/sync/state/types.ts
 * changes:  none
 */

import { ComponentValue } from 'engine/recs';
import { NetworkComponentUpdate } from 'workers/types';

// represents a single state entry for a Component. entityIndex->value
export type StateEntry = Map<number, ComponentValue>;

// represents a mapping from an Entity ID to its Entity Index
export type IDIndexMap = Map<string, number>;

// a state update event (i.e. a component update sans tx metadata)
export type StateEvent = Omit<NetworkComponentUpdate, 'lastEventInTx' | 'txHash'>;
