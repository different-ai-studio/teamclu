import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appLib = resolve(here, '../../packages/app/src/lib')

export default defineConfig({
  resolve: {
    alias: {
      '@teamclu/extension-link-hover': resolve(appLib, 'extension/link-hover/index.ts'),
      '@teamclu/extension-link-session': resolve(appLib, 'extension/link-session/index.ts'),
    },
  },
  define: {
    __TEAMCLU_EXTENSION_SETTINGS__: JSON.stringify({}),
  },
  test: {
    environment: 'node',
  },
})
