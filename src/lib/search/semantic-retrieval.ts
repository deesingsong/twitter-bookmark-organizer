import { reciprocalRankFusion, type ReciprocalRankCandidate } from "./rrf";

export const MAX_SEARCH_CANDIDATES = 200;
export const HYBRID_RRF_CONSTANT = 60;

/** The query's embedding contract; pass the shared, pinned BGE contract here. */
export interface SemanticEmbeddingSpace {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly preprocessingVersion: string;
  readonly dimensions: number;
}

/** A distance computed against the query vector, with its stored embedding metadata. */
export interface SemanticDistanceCandidate extends SemanticEmbeddingSpace {
  readonly id: string;
  readonly status: string;
  readonly cosineDistance: number | null;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_SEARCH_CANDIDATES) {
    throw new RangeError(`Candidate limit must be an integer from 0 to ${MAX_SEARCH_CANDIDATES}.`);
  }
}

function validateSpace(space: SemanticEmbeddingSpace): void {
  if (space.dimensions !== 384 || !space.modelId.trim() || !space.modelRevision.trim()
    || !space.preprocessingVersion.trim()) {
    throw new Error("Semantic retrieval requires a complete 384-dimensional embedding contract.");
  }
}

function validateId(id: string, seen: Set<string>): void {
  if (!id.trim()) throw new Error("Search candidate IDs must be nonempty strings.");
  if (seen.has(id)) throw new Error("Each retrieval branch must contain unique candidate IDs.");
  seen.add(id);
}

/**
 * Rank ready BGE 384D distances, ascending, with code-point ID ties. Incompatible
 * metadata, absent distances, and nonfinite/out-of-range distances are excluded.
 * Eligibility and structured filters are applied before the candidate limit.
 *
 * Database callers must apply these predicates before their own LIMIT as well;
 * this helper cannot recover rows discarded by an earlier database limit. The
 * supplied space must describe the query vector that produced these distances.
 */
export function rankSemanticCandidates<T extends SemanticDistanceCandidate>(
  candidates: readonly T[],
  options: {
    readonly space: SemanticEmbeddingSpace;
    readonly filter?: (candidate: T) => boolean;
    readonly limit?: number;
  },
): T[] {
  const limit = options.limit ?? MAX_SEARCH_CANDIDATES;
  validateLimit(limit);
  validateSpace(options.space);

  const seen = new Set<string>();
  const eligible = candidates.filter((candidate) => {
    if (candidate.status !== "ready" || candidate.modelId !== options.space.modelId
      || candidate.modelRevision !== options.space.modelRevision
      || candidate.preprocessingVersion !== options.space.preprocessingVersion
      || candidate.dimensions !== options.space.dimensions
      || candidate.cosineDistance === null || !Number.isFinite(candidate.cosineDistance)
      || candidate.cosineDistance < 0 || candidate.cosineDistance > 2
      || (options.filter && !options.filter(candidate))) return false;
    validateId(candidate.id, seen);
    return true;
  });

  return eligible.sort((left, right) => left.cosineDistance! - right.cosineDistance!
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).slice(0, limit);
}

export interface FusedSearchCandidate extends ReciprocalRankCandidate {
  /** One-based position in the caller's exact/URL/username precedence list, or null. */
  readonly priorityRank: number | null;
}

function filterAndBoundRanking(
  ids: readonly string[],
  filter: ((id: string) => boolean) | undefined,
  limit: number,
): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const id of ids) {
    validateId(id, seen);
    if ((!filter || filter(id)) && selected.length < limit) selected.push(id);
  }
  return selected;
}

/**
 * Fuse complete, cursor-independent branch rankings using RRF: sum 1/(60 + rank),
 * with one-based ranks and code-point ID ties. Raw lexical and distance scores
 * are never added. Apply pagination only after computing this ranking.
 *
 * The caller supplies exact-ID/URL/username/phrase matches in precedence order.
 * They precede fused results without changing their RRF scores; an exact-only
 * candidate has score zero. They need no embedding or semantic model. Missing
 * semantic ranks preserve lexical order. The same filter runs on every branch
 * before its limit, including the independent exact-match precedence layer.
 */
export function fuseSearchRankings(options: {
  readonly lexicalIds: readonly string[];
  readonly semanticIds?: readonly string[] | null;
  readonly priorityIds?: readonly string[];
  readonly filter?: (id: string) => boolean;
  /** Maximum candidates per lexical/semantic branch; hard cap 200. */
  readonly candidateLimit?: number;
  /** Maximum results, including priority matches; hard cap 200. */
  readonly limit?: number;
}): FusedSearchCandidate[] {
  const candidateLimit = options.candidateLimit ?? MAX_SEARCH_CANDIDATES;
  const limit = options.limit ?? MAX_SEARCH_CANDIDATES;
  validateLimit(candidateLimit);
  validateLimit(limit);

  const lexical = filterAndBoundRanking(options.lexicalIds, options.filter, candidateLimit);
  const semantic = filterAndBoundRanking(options.semanticIds ?? [], options.filter, candidateLimit);
  const priority = filterAndBoundRanking(options.priorityIds ?? [], options.filter, MAX_SEARCH_CANDIDATES);
  // Keep the entire bounded union until precedence has been applied, then limit.
  const fused = reciprocalRankFusion([lexical, semantic], {
    constant: HYBRID_RRF_CONSTANT,
    limit: lexical.length + semantic.length,
  });
  const scores = new Map(fused.map(({ id, score }) => [id, score]));
  const priorityIds = new Set(priority);

  return [
    ...priority.map((id, index) => ({ id, score: scores.get(id) ?? 0, priorityRank: index + 1 })),
    ...fused.filter(({ id }) => !priorityIds.has(id)).map((candidate) => ({ ...candidate, priorityRank: null })),
  ].slice(0, limit);
}
