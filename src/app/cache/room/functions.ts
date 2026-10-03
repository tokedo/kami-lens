/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ffda396330af1bc33238b6c37188772152b45439
 * path:     packages/client/src/app/cache/room/functions.ts
 * changes:  none
 */

import { World } from "engine/recs";

import { Account } from "../account";
import { Room } from "../room";
import { Components } from "network/";
import { passesConditions } from "network/shapes/Conditional";
