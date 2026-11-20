/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi-open @ a99b4b64b505b722203b2337f76a5b604539c1e0
 * path:     packages/client/src/app/cache/room/functions.ts
 * changes:  none
 */

import { World } from "engine/recs";

import { Account } from "../account";
import { Room } from "../room";
import { Components } from "network/";
import { passesConditions } from "network/shapes/Conditional";
