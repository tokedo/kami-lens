import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'gates/.artifacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Ported upstream code is kept verbatim (DESIGN §3.4); rules that would
    // force edits to faithful ports are relaxed globally rather than
    // per-file, so ported and native code lint identically. Unused-directive
    // reporting is off for the same reason: upstream files carry
    // eslint-disable comments for rules this config relaxes.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true }],
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain-JS Node loader hooks (gates); js.configs.recommended has no
    // environment globals, so declare the ones they use.
    files: ['**/*.mjs'],
    languageOptions: { globals: { URL: 'readonly' } },
  },
  {
    // Ported and vendored trees stay byte-faithful to upstream (DESIGN §3.4),
    // so style rules that would force edits there are off. Native kami-lens
    // code (src/*.ts at the top level, gates, scripts, tests) keeps them.
    files: [
      'src/abi/**',
      'src/app/**',
      'src/assets/**',
      'src/cache/**',
      'src/clients/**',
      'src/constants/**',
      'src/engine/**',
      'src/network/**',
      'src/types/**',
      'src/utils/**',
      'src/vendor/**',
      'src/workers/**',
    ],
    rules: {
      'no-empty': 'off',
      'no-extra-boolean-cast': 'off',
      'no-var': 'off',
      'prefer-const': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  }
);
