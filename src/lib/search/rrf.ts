export interface ReciprocalRankCandidate {
  readonly id: string;
  readonly score: number;
}

/** Fuse independent ranked lists without combining incompatible raw scores. */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  options: { constant?: number; limit?: number } = {},
): ReciprocalRankCandidate[] {
  const constant = options.constant ?? 60;
  const limit = options.limit ?? 200;
  if (!Number.isInteger(constant) || constant < 0) throw new Error("RRF constant must be a nonnegative integer.");
  if (!Number.isInteger(limit) || limit < 0) throw new Error("RRF limit must be a nonnegative integer.");

  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    for (const [index, id] of ranking.entries()) {
      if (!id.trim()) throw new Error("RRF candidate IDs must be nonempty strings.");
      if (seen.has(id)) throw new Error("Each retrieval branch must contain unique candidate IDs.");
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (constant + index + 1));
    }
  }

  return [...scores].map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .slice(0, limit);
}
