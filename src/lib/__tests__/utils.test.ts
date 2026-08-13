import { describe, it, expect } from 'vitest'
import { cn } from '@/lib/utils'

describe('cn (className combiner)', () => {
  it('passes through a single string unchanged', () => {
    expect(cn('foo')).toBe('foo')
  })

  it('joins multiple strings with a single space', () => {
    expect(cn('foo', 'bar', 'baz')).toBe('foo bar baz')
  })

  it('drops falsy values (undefined, null, false, "")', () => {
    expect(cn('foo', undefined, null, false, '', 'bar')).toBe('foo bar')
  })

  it('supports conditional class objects (clsx syntax)', () => {
    expect(cn('base', { active: true, hidden: false })).toBe('base active')
  })

  it('supports arrays of class names', () => {
    expect(cn('base', ['a', 'b', { c: true, d: false }])).toBe('base a b c')
  })

  it('deduplicates conflicting Tailwind classes via tailwind-merge', () => {
    // tailwind-merge's whole job: when two conflicting utilities are present,
    // the later one wins. p-2 then p-4 → p-4.
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500')
  })

  it('keeps non-conflicting classes untouched', () => {
    expect(cn('p-4', 'text-red-500', 'rounded')).toBe('p-4 text-red-500 rounded')
  })

  it('handles no arguments gracefully (returns empty string)', () => {
    expect(cn()).toBe('')
  })
})
