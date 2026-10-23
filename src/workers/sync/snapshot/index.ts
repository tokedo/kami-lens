/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/workers/sync/snapshot/index.ts
 * history:  forward-ported in 0.6.2 from @ 21f419e63e0a7f6b642c255efeb89dd1c288de1c
 *           while that commit was ahead of the pin; the pin now includes it.
 * changes:  none
 */

export { create as createSnapshotClient } from './create';
export { fetchSnapshot } from './fetch';
export { fetchFromCdn, planCdnLoad } from './fetchFromCdn';

export { isRateLimited } from './utils';
