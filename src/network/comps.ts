// kami-lens shim (not a port) — upstream quirk kept on the record: two files
// (app/cache/config/kami.ts, network/shapes/Kami/getters.ts) import
// { Components } from 'network/comps', but no comps module exists in the
// upstream tree at the pin. The specifier survives upstream only because the
// import is type-only and esbuild erases it without resolving. Ported bodies
// keep the specifier verbatim (§3.4: preserve tangles); this shim makes it
// resolve to the real Components type.
// upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
// path:     (absent upstream — phantom specifier)

export type { Components } from './components';
