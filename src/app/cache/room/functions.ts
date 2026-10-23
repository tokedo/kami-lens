/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 04cb25f8f3009ca9b89e62e20bd3d7afa12e98ad
 * path:     packages/client/src/app/cache/room/functions.ts
 * changes:  none
 */

import { World } from "engine/recs";

import { Account } from "../account";
import { Room } from "../room";
import { Components } from "network/";
import { passesConditions } from "network/shapes/Conditional";
