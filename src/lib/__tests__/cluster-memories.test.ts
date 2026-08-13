import { describe, it, expect } from 'vitest'
import { clusterMemories } from '@/lib/cluster-memories'

describe('clusterMemories', () => {
  it('groups memories by their category field', () => {
    const memories = [
      { category: 'personal', content: 'lives in Berlin' },
      { category: 'preference', content: 'likes sci-fi' },
      { category: 'personal', content: 'has a dog' },
      { category: 'goal', content: 'learn piano' },
    ]
    const result = clusterMemories(memories)
    expect(Object.keys(result).sort()).toEqual(['goal', 'personal', 'preference'])
    expect(result.personal).toHaveLength(2)
    expect(result.preference).toHaveLength(1)
    expect(result.goal).toHaveLength(1)
  })

  it('falls back to "general" bucket when category is empty string', () => {
    const memories = [
      { category: '', content: 'no category set' },
      { category: 'personal', content: 'with category' },
    ]
    const result = clusterMemories(memories)
    expect(result.general).toHaveLength(1)
    expect(result.personal).toHaveLength(1)
  })

  it('returns an empty object for empty input', () => {
    expect(clusterMemories([])).toEqual({})
  })

  it('preserves extra fields on the memory objects', () => {
    // The function is generic over T — it should not strip fields.
    const memories = [
      { category: 'personal', content: 'lives in Berlin', id: 'mem-1', pinned: true, createdAt: '2026-01-01' },
    ]
    const result = clusterMemories(memories)
    expect(result.personal[0]).toEqual({
      category: 'personal',
      content: 'lives in Berlin',
      id: 'mem-1',
      pinned: true,
      createdAt: '2026-01-01',
    })
  })

  it('treats null/undefined category as "general" (defensive)', () => {
    // Defensive: real DB rows might have null category if a migration didn't
    // backfill. `m.category || 'general'` should catch both '' and null/undefined.
    const memories = [
      { category: null as unknown as string, content: 'null cat' },
      { category: undefined as unknown as string, content: 'undef cat' },
    ]
    const result = clusterMemories(memories)
    expect(result.general).toHaveLength(2)
  })
})
