import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
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
  }
);
