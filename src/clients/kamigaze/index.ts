/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/clients/kamigaze/index.ts
 * changes:  partial port — upstream also re-exports getClient as
 *           getKamigazeClient (the import.meta.env singleton, not ported;
 *           swap point 1). Everything else is verbatim.
 */

export { createKamigazeClient } from './client';

export type {
  BlockRequest,
  BlockResponse,
  Component,
  ComponentsRequest,
  ComponentsResponse,
  DeepPartial,
  ECSEvent,
  EntitiesRequest,
  EntitiesResponse,
  Entity,
  GetEventsSinceRequest,
  GetEventsSinceResponse,
  KamigazeServiceClient,
  KamigazeServiceImplementation,
  MessageFns,
  ServerStreamingMethodResult,
  State,
  StateRequest,
  StateResponse,
  StreamRequest,
  StreamResponse,
  TxMetadata,
} from './proto';

export { KamigazeServiceDefinition as KamigazeServiceDefinition } from './proto';
