import { cp } from 'node:fs/promises';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
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
