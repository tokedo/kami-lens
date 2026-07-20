// kami-lens public surface. Populated as milestones land (PORT_PLAN.md).
// M0: pure leaf utilities (hash/pack/decode) ported from the upstream pin.
// M1: the sync daemon (mirror, checkpointing, status).

export { ERR_NO_SNAPSHOT_SOURCE, KamiLensDaemon, startDaemon } from './daemon';
export type { CheckpointReport, DaemonStatus } from './daemon';
export { YOMINET_DEFAULTS, getDataDir, resolveConfig } from './config';
export type { KamiLensConfig } from './config';
export { tripwireReport, tripwires } from './tripwires';
export type { Tripwires } from './tripwires';
export { SyncState } from 'engine/constants';
export type { SyncStatus } from 'engine/constants';
export type { StateCache } from 'workers/sync/state';

export { getEntityByHash, hashArgs } from 'network/shapes/utils/IDs';
export { unpackArray32 } from 'network/shapes/utils/packing';
export { pack, packTuple, unpack, unpackTuple } from '@mud-classic/utils';
export { createDecode, createDecoder, createEncoder } from 'engine/encoders';
export type { Decode } from 'engine/encoders';
export {
  ContractSchemaValue,
  ContractSchemaValueArrayToElement,
  ContractSchemaValueId,
} from 'engine/encoders/types';
export type { ContractSchemaValueTypes } from 'engine/encoders/types';
export { flattenValue } from 'engine/encoders/utils';
export { formatComponentID, formatEntityID } from 'engine/utils';
export { ComponentsSchema } from 'types/ComponentsSchema';
export { Type, UpdateType } from 'engine/recs';
export type { ComponentValue, EntityID, EntityIndex, Schema, World } from 'engine/recs';
