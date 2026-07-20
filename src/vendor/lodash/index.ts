// kami-lens shim (not a port): ported upstream files import 'lodash'
// verbatim, but Node's ESM loader cannot named-import CJS lodash (vite
// handled that in the browser build — swap point 7 territory). The bare
// specifier resolves here via tsconfig paths and re-exports lodash-es,
// the same 4.17.21 codebase published as real ESM (typed by
// @types/lodash-es).

export * from 'lodash-es';
