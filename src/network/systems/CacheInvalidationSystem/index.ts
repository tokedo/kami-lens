/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/network/systems/CacheInvalidationSystem/index.ts
 * changes:  none. (M4 — the third Kamiden feed consumer: kami casts and
 *           kills arriving on the stream invalidate the affected kami/bonus
 *           cache rows so library consumers reading the app/cache getters
 *           see post-event state without waiting out TTLs. The daemon wires
 *           it via subscribeToFeed once feeds start; the query surface's
 *           forced-refresh path never relies on it. Not wired: upstream's
 *           other subscribeToFeed consumer, DTRevealerSystem — that backs
 *           the notifications row, which is deferred with its own design
 *           pass, coverage.md.)
 */

import { invalidateTempBonusesCache } from 'app/cache/bonus';
import { invalidateKamiAfterCast, invalidateKamiAfterKill } from 'app/cache/kami';
import { KamiCast, Kill, subscribeToFeed } from 'clients/kamiden';
import { formatEntityID } from 'engine/utils';
import { NetworkLayer } from 'network/';
import { log } from 'utils/logger';

export function setupCacheInvalidationHandler(network: NetworkLayer) {
  const { world } = network;

  return subscribeToFeed((feed) => {
    feed.KamiCasts.forEach((cast: KamiCast) => {
      const targetID = formatEntityID(cast.TargetID);
      const targetEntity = world.entityToIndex.get(targetID);
      if (targetEntity === undefined) return;

      log.debug(`CacheInvalidation: cast on entity ${targetEntity} (item ${cast.itemIndex})`);
      invalidateKamiAfterCast(targetEntity);
      invalidateTempBonusesCache(world, targetEntity);
    });

    feed.Kills.forEach((kill: Kill) => {
      const killerID = formatEntityID(kill.KillerId);
      const victimID = formatEntityID(kill.VictimId);

      const killerEntity = world.entityToIndex.get(killerID);
      const victimEntity = world.entityToIndex.get(victimID);

      if (killerEntity !== undefined) {
        log.debug(`CacheInvalidation: killer ${killerEntity}`);
        invalidateKamiAfterKill(killerEntity);
        invalidateTempBonusesCache(world, killerEntity);
      }

      if (victimEntity !== undefined) {
        log.debug(`CacheInvalidation: victim ${victimEntity}`);
        invalidateKamiAfterKill(victimEntity);
        invalidateTempBonusesCache(world, victimEntity);
      }
    });
  });
}
