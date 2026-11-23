/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ 1b0b34e58537fca324c65237c1a056495c95892e
 * path:     packages/client/src/app/cache/room/functions.ts
 * changes:  none
 */

import { World } from "engine/recs";

import { Account } from "../account";
import { Room } from "../room";
import { Components } from "network/";
import { passesConditions } from "network/shapes/Conditional";
