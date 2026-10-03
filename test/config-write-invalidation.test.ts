// 1.0.0 (B4): the config caches invalidate on config writes.
//
// Upstream caches config fields for the life of the page and says so ("updates
// require refresh"). A daemon runs for weeks, so before 1.0.0 an admin config
// change was served stale until restart. Nothing here is mocked: the synthetic
// mirror carries the live world's own config arrays, the reader is the ported
// network/shapes/Config, and the write goes through RECS setComponent — the
// same call the mirror's apply path makes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArrayCache,
  ValueCache,
  clearConfigCaches,
  configInvalidations,
  getArray,
  getValue,
  watchConfigWrites,
} from "app/cache/config/base";
import { removeComponent, setComponent } from "engine/recs";
import { getEntityByHash } from "network/shapes/utils";

import {
  LIVE_KAMI_CONFIG,
  LIVE_KAMI_CONFIG_VALUES,
  makeMirror,
  packArray32,
} from "./support/mirror";
import type { Subscription } from "rxjs";

const configEntity = (m: ReturnType<typeof makeMirror>, field: string) =>
  getEntityByHash(m.world, ["is.config", field], ["string", "string"])!;

let sub: Subscription | undefined;
beforeEach(() => clearConfigCaches());
afterEach(() => {
  sub?.unsubscribe();
  sub = undefined;
  clearConfigCaches();
});

describe("config caches invalidate on config writes (B4)", () => {
  it("an array field re-reads after its config entity is written", () => {
    const m = makeMirror();
    let derived = 0;
    sub = watchConfigWrites(m.components, () => derived++);
    const field = "KAMI_HARV_INTENSITY";
    expect(getArray(m.world, m.components, field)).toEqual(
      LIVE_KAMI_CONFIG[field],
    );
    expect(ArrayCache.has(field)).toBe(true);

    const next = [7, 0, 1200, 0, 0, 0, 10, 0];
    setComponent(m.components.Value, configEntity(m, field), {
      value: packArray32(next) as unknown as number,
    });
    expect(ArrayCache.has(field)).toBe(false);
    expect(getArray(m.world, m.components, field)).toEqual(next);
    expect(derived).toBe(1); // the derived-cache hook ran once
  });

  it("a scalar field re-reads after its config entity is written", () => {
    const m = makeMirror();
    sub = watchConfigWrites(m.components);
    const field = "KAMI_STANDARD_COOLDOWN";
    expect(getValue(m.world, m.components, field)).toBe(
      LIVE_KAMI_CONFIG_VALUES[field],
    );
    expect(ValueCache.has(field)).toBe(true);
    setComponent(m.components.Value, configEntity(m, field), {
      value: "0xf0" as unknown as number,
    });
    expect(getValue(m.world, m.components, field)).toBe(240);
  });

  it("a removal of the config value invalidates too (the field re-reads)", () => {
    const m = makeMirror();
    sub = watchConfigWrites(m.components);
    const field = "KAMI_STANDARD_COOLDOWN";
    getValue(m.world, m.components, field);
    removeComponent(m.components.Value, configEntity(m, field));
    expect(ValueCache.has(field)).toBe(false);
    // the ported reader answers NaN for an entity whose Value is gone
    // (`undefined * 1`); what matters here is that the stale 180 is not
    // served and nothing non-finite is cached
    expect(Number.isNaN(getValue(m.world, m.components, field))).toBe(true);
    expect(ValueCache.has(field)).toBe(false);
  });

  it("a Value write on a non-config entity drops nothing", () => {
    const m = makeMirror();
    let derived = 0;
    sub = watchConfigWrites(m.components, () => derived++);
    getArray(m.world, m.components, "KAMI_HARV_INTENSITY");
    const before = { ...configInvalidations };
    const other = m.world.registerEntity({ id: "0xabc" as never });
    setComponent(m.components.Value, other, { value: 5 });
    expect(ArrayCache.has("KAMI_HARV_INTENSITY")).toBe(true);
    expect(configInvalidations).toEqual(before);
    expect(derived).toBe(0);
  });

  it("only the written field is dropped; its neighbours stay cached", () => {
    const m = makeMirror();
    sub = watchConfigWrites(m.components);
    getArray(m.world, m.components, "KAMI_HARV_INTENSITY");
    getArray(m.world, m.components, "KAMI_HARV_STRAIN");
    setComponent(m.components.Value, configEntity(m, "KAMI_HARV_STRAIN"), {
      value: packArray32([1, 0, 2, 0, 0, 0, 3, 0]) as unknown as number,
    });
    expect(ArrayCache.has("KAMI_HARV_INTENSITY")).toBe(true);
    expect(ArrayCache.has("KAMI_HARV_STRAIN")).toBe(false);
  });

  it("clearConfigCaches empties every cache (a new world)", () => {
    const m = makeMirror();
    getArray(m.world, m.components, "KAMI_HARV_INTENSITY");
    getValue(m.world, m.components, "KAMI_STANDARD_COOLDOWN");
    clearConfigCaches();
    expect(ArrayCache.size).toBe(0);
    expect(ValueCache.size).toBe(0);
  });

  it("without the watcher a write is NOT seen (the defect, pinned)", () => {
    const m = makeMirror();
    const field = "KAMI_HARV_INTENSITY";
    getArray(m.world, m.components, field);
    setComponent(m.components.Value, configEntity(m, field), {
      value: packArray32([9, 0, 9, 0, 0, 0, 9, 0]) as unknown as number,
    });
    expect(getArray(m.world, m.components, field)).toEqual(
      LIVE_KAMI_CONFIG[field],
    );
  });
});
