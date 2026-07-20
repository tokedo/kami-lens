/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/workers/sync/snapshot/utils.ts
 * changes:  port hygiene (DESIGN §4.1) — the browser-only fetch option
 *           `mode: 'cors'` is dropped from the health-endpoint check.
 *           Everything else verbatim.
 */

async function checkFor403(url: string) {
  var is403 = false;
  var response;
  try {
    response = await fetch(`${url}/healthy`, {
      // Use the base URL
      method: 'GET',
    });
  } catch (e) {}
  is403 = response?.status == 403;
  return is403;
}

function checkForGrpc8(e: any) {
  const errorCode = e.code || 'unknown';
  return errorCode == 8;
}

export function isRateLimited(url: string, e: any) {
  return checkForGrpc8(e) || checkFor403(url);
}
