/**
 * clusterMemories — cheap single-pass clustering by category, refined by
 * simple keyword grouping within each category. This is intentionally NOT
 * real embedding-based clustering (k-means, etc.) — that's meaningfully more
 * complex for a UI grouping feature that just needs "roughly sensible
 * buckets," not ML-grade accuracy. If the category field already captures
 * personal/preference/goal/fact/general, lean on that first.
 *
 * Honest tradeoff: true embedding-based clustering (grouping by semantic
 * similarity regardless of category label) is a bigger lift — it needs a
 * clustering algorithm (k-means or agglomerative) run over the actual
 * vectors, which is more code and more to get wrong for a "nice to have"
 * UI grouping. Grouping by the existing `category` field first is free,
 * already accurate most of the time (since detection already assigns sensible
 * categories), and ships today. If category-based grouping feels too coarse
 * once you're using it, that's the signal to come back and do real vector
 * clustering — don't build the complex version speculatively.
 */
export function clusterMemories<T extends { category: string; content: string }>(
  memories: T[]
): Record<string, T[]> {
  const groups: Record<string, T[]> = {}
  for (const m of memories) {
    const key = m.category || 'general'
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }
  return groups
}
