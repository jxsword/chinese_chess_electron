import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'dist-web/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/shared/**/*.ts',
      'src/packages/**/*.ts',
      'test/**/*.{ts,tsx}',
      '*.config.ts'
    ],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['tools/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // E2E：Node 运行器 + 页面内 eval（waitForFunction 回调在浏览器上下文执行）。
    files: ['e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
)
