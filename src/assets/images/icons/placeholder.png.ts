// kami-lens shim (not a port): stands in for the binary asset
// packages/client/src/assets/images/icons/placeholder.png. Ported files
// import the '.png' specifier verbatim; TS/esbuild extension probing
// resolves it here. Note the upstream quirk this preserves: two shapes
// files (utils/parse.ts, Allo/interpretation.ts) do
// `import * as placeholder from '...placeholder.png'` and use the module
// NAMESPACE (an object `{ default: url }`), not the url string, as the
// image value — mirrored exactly by exporting the token as default.

export default 'assets/images/icons/placeholder.png';
