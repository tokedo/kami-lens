import { cp } from 'node:fs/promises';

import { defineConfig } from 'tsup';

export default defineConfig({
  // src/checkpoint-child.ts is a PROCESS ENTRY (0.6.3, divergence 16): the
  // daemon forks it every checkpoint interval, resolving
  // <package root>/dist/checkpoint-child.js. It must be its own bundle, and
  // it must land at exactly that path — tsup derives output paths from the
  // common ancestor of the entries, which is why the entry file is flat in
  // src/ rather than beside its job in src/workers/checkpoint/.
  // `files: ["dist"]` already ships it; G5.a/G5.b assert it runs from the
  // packaged artifact.
  entry: ['src/index.ts', 'src/cli.ts', 'src/checkpoint-child.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  // the checked-in query schemas ship next to the bundle — loadSchema
  // resolves <module dir>/schemas in both the src and dist layouts (M5)
  onSuccess: async () => {
    await cp('src/queries/schemas', 'dist/schemas', { recursive: true });
  },
});
