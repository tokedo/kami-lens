// Node ESM load hook for the G2.a upstream runner: binary image imports in
// the PINNED UPSTREAM tree (vite serves these as asset URLs in the browser
// build) load as modules whose default export is the file URL string —
// vite's contract, headless. Images never enter the integer math under test.
const ASSET_RE = /\.(png|webp|jpe?g|gif|svg)$/;

export async function load(url, context, nextLoad) {
  if (ASSET_RE.test(new URL(url).pathname)) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(url)};`,
    };
  }
  return nextLoad(url, context);
}
