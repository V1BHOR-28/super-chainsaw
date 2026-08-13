import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Vitest configuration for ARIA.
 *
 * - `environment: 'jsdom'` so any test that imports a React component
 *   (even transitively, via a lib module that imports a hook) gets a DOM.
 * - `setupFiles` wires @testing-library/jest-dom matchers (`toBeInTheDocument`,
 *   etc.) so component tests read naturally.
 * - `alias` mirrors the `@/*` path from tsconfig.json so `import { foo } from
 *   '@/lib/foo'` resolves the same way it does in the app.
 * - `include` only matches files under `src/` and `tests/` — keeps Vitest from
 *   picking up random scripts in `mini-services/` or `node_modules/`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    // Skip live-DB / live-API smoke tests under the default `test` script.
    // Those run via the dedicated `verify:memory` script in CI with secrets.
    exclude: ['node_modules/**', '.next/**', 'tests/smoke/**'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/*.test.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
