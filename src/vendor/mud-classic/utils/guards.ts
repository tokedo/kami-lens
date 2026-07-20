/**
 * kami-lens vendored dependency (MIT, compatible with this repo's AGPL-3.0).
 * package:   @mud-classic/utils@0.0.3 — the exact artifact the upstream client
 *            resolves (integrity matches upstream pnpm-lock.yaml at the pin).
 * source:    src/guards.ts, recovered verbatim from the published artifact's
 *            source maps.
 * copyright: (c) 2022-present Lattice Labs Ltd. (MIT License)
 * changes:   none
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Func } from "./types";

export function isObject(c: unknown): c is Record<string, any> {
  return typeof c === "object" && !Array.isArray(c) && c !== null;
}

export function isFunction(c: unknown): c is Func<any, any> {
  return c instanceof Function;
}
