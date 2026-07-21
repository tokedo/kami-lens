/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/app/cache/room/functions.ts
 * changes:  none
 */

import { World } from "engine/recs";

import { Account } from "../account";
import { Room } from "../room";
import { Components } from "network/";
import { passesConditions } from "network/shapes/Conditional";
