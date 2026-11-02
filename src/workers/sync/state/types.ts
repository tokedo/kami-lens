/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 8fb6ea58be5f773909a4d6d8db32f4726512b8e0
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
