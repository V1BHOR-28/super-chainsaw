/**
 * Vitest setup — runs once before any test file.
 *
 * Wires @testing-library/jest-dom's custom matchers (`toBeInTheDocument`,
 * `toHaveTextContent`, etc.) onto Vitest's `expect`, so component tests can
 * use them without per-file imports.
 *
 * Also stubs `IndexedDB` minimally for the cover-cache module's tests —
 * jsdom 30 still doesn't ship a real IndexedDB implementation, so any module
 * that touches `indexedDB` would otherwise throw on import. The stub is a
 * no-op that returns null/undefined from every call, which matches the
 * cover-cache module's "fail-soft → return null" contract.
 */
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// jsdom doesn't implement IndexedDB. Provide a no-op stub so modules that
// touch it on import don't crash. Individual tests that need real behavior
// can override via `vi.stubGlobal('indexedDB', fakeIndexedDB)`.
if (!('indexedDB' in globalThis)) {
  ;(globalThis as Record<string, unknown>).indexedDB = {
    open: () => ({
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      result: null,
    }),
  }
}

// jsdom doesn't implement URL.createObjectURL either; some modules reference
// it. No-op stub. (Cast through `as typeof URL` because TS thinks the lib's
// URL always has these — they exist at runtime in node but not in jsdom.)
const URLCtor = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }
if (typeof URLCtor.createObjectURL !== 'function') {
  URLCtor.createObjectURL = vi.fn(() => 'blob:mock')
}
if (typeof URLCtor.revokeObjectURL !== 'function') {
  URLCtor.revokeObjectURL = vi.fn()
}

// Silence console.error / console.warn in tests unless a test explicitly
// opts back in. Keeps test output readable when modules intentionally log
// warnings on error paths (which is the correct production behavior).
const originalError = console.error
const originalWarn = console.warn
console.error = (...args: unknown[]) => {
  if (process.env.VITEST_VERBOSE === '1') originalError(...args)
}
console.warn = (...args: unknown[]) => {
  if (process.env.VITEST_VERBOSE === '1') originalWarn(...args)
}
