/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/clients/kamigaze/index.ts
 * forward-port: @ 21f419e63e0a7f6b642c255efeb89dd1c288de1c (sync-affecting
 *           bucket, ahead of the pin — SPEC §4.2)
 * changes:  partial port — upstream also re-exports getClient as
 *           getKamigazeClient (the import.meta.env singleton, not ported;
 *           swap point 1). The forward-port moves ComponentsResponse,
 *           EntitiesResponse and StateResponse from the type-only block to
 *           the VALUE block: the CDN path calls `.decode` on them (the
 *           chunks are raw protobuf off an object store, not gRPC frames),
 *           and a type-only export cannot be called. They remain usable as
 *           types — a value export of an interface + const pair carries
 *           both. Everything else is verbatim.
 */

export { createKamigazeClient } from './client';

export type {
  BlockRequest,
  BlockResponse,
  Component,
  ComponentsRequest,
  DeepPartial,
  ECSEvent,
  EntitiesRequest,
  Entity,
  GetEventsSinceRequest,
  GetEventsSinceResponse,
  KamigazeServiceClient,
  KamigazeServiceImplementation,
  MessageFns,
  ServerStreamingMethodResult,
  State,
  StateRequest,
  StreamRequest,
  StreamResponse,
  TxMetadata,
} from './proto';

export {
  ComponentsResponse,
  EntitiesResponse,
  KamigazeServiceDefinition,
  StateResponse,
} from './proto';
