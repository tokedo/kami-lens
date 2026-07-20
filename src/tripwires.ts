// kami-lens native module (not a port): runtime tripwire counters, DESIGN §7.
// Contract-side drift must announce itself even if no one has diffed the
// upstream repo. Ported files increment these at the sites where upstream
// only warned; the daemon surfaces the counts in status output.

export type Tripwires = {
  /** stream/gapfill event whose componentId has no mapping in the registry */
  unknownComponentIds: number;
  /** componentId with no entry in ComponentsSchema (decoded via bool fallback) */
  unknownComponentSchemas: number;
  /** component-value decode threw */
  decodeFailures: number;
  /** Kamigaze nonce changed against a previously synced nonce (full reload forced) */
  kamigazeNonceBumps: number;
};

export const tripwires: Tripwires = {
  unknownComponentIds: 0,
  unknownComponentSchemas: 0,
  decodeFailures: 0,
  kamigazeNonceBumps: 0,
};

export function tripwireReport(): Tripwires {
  return { ...tripwires };
}
