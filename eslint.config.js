import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'playwright-report/', 'test-results/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Node 脚本（scripts/）：补充 Node 全局变量，否则 no-undef 误报 URL/console 等
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
)
