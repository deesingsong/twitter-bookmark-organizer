import { SYNTHETIC_SEMANTIC_QUERIES } from "./fixtures";
import type {
  MetricsAt10,
  RelevanceJudgments,
  ScoredSemanticCandidate,
  SemanticEvaluationQuery,
  SemanticEvaluationRanker,
  SemanticEvaluationReport,
  SemanticMetricSummary,
  SemanticQueryKind,
  SemanticQueryResult,
} from "./types";

const CUTOFF = 10;

function validateJudgments(relevance: RelevanceJudgments): void {
  for (const [id, grade] of Object.entries(relevance)) {
    if (!id.trim() || !Number.isInteger(grade) || grade < 1 || grade > 3) {
      throw new Error("Relevance judgments require nonempty IDs and integer grades from 1 to 3.");
    }
  }
}

/** Descending similarity, then ascending ID by UTF-16 code units, independent of locale. */
export function rankDeterministically(
  candidates: readonly ScoredSemanticCandidate[],
  limit: number = CUTOFF,
): string[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be a nonnegative integer.");
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.id.trim() || !Number.isFinite(candidate.score)) {
      throw new Error("Candidates require nonempty IDs and finite scores.");
    }
    if (ids.has(candidate.id)) throw new Error("Candidate IDs must be unique.");
    ids.add(candidate.id);
  }
  return [...candidates].sort((left, right) => {
    if (left.score !== right.score) return left.score > right.score ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }).slice(0, limit).map((candidate) => candidate.id);
}

/**
 * Positive grades count equally for Recall, Precision, and MRR. Precision@10
 * always divides by ten, including short result lists. nDCG uses (2^grade - 1)
 * gains and log2(rank + 1) discounts. Duplicate IDs consume rank but earn no
 * second gain; hits after rank ten never contribute. Empty judgments are unscored.
 */
export function calculateMetricsAt10(
  rankedIds: readonly string[],
  relevance: RelevanceJudgments,
): MetricsAt10 {
  validateJudgments(relevance);
  const grades = Object.values(relevance);
  if (!grades.length) return {
    recallAt5: null, recallAt10: null, precisionAt10: null, reciprocalRankAt10: null, ndcgAt10: null,
  };

  let foundAt5 = 0;
  let found = 0;
  let reciprocalRank = 0;
  let discountedGain = 0;
  const seen = new Set<string>();
  for (const [index, id] of rankedIds.slice(0, CUTOFF).entries()) {
    if (seen.has(id)) continue;
    seen.add(id);
    // Map lookup avoids treating inherited object properties as judgments.
    if (!Object.prototype.hasOwnProperty.call(relevance, id)) continue;
    const grade = relevance[id];
    found++;
    if (index < 5) foundAt5++;
    if (!reciprocalRank) reciprocalRank = 1 / (index + 1);
    discountedGain += (2 ** grade - 1) / Math.log2(index + 2);
  }
  const idealGain = grades.sort((left, right) => right - left).slice(0, CUTOFF)
    .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  return {
    recallAt5: foundAt5 / grades.length,
    recallAt10: found / grades.length,
    precisionAt10: found / CUTOFF,
    reciprocalRankAt10: reciprocalRank,
    ndcgAt10: discountedGain / idealGain,
  };
}

function summarize(results: readonly SemanticQueryResult[]): SemanticMetricSummary {
  const judged = results.filter((result) => result.recallAt10 !== null);
  return {
    queryCount: results.length,
    judgedQueryCount: judged.length,
    meanRecallAt5: judged.length ? judged.reduce((sum, row) => sum + (row.recallAt5 ?? 0), 0) / judged.length : null,
    meanRecallAt10: judged.length ? judged.reduce((sum, row) => sum + (row.recallAt10 ?? 0), 0) / judged.length : null,
    meanPrecisionAt10: judged.length ? judged.reduce((sum, row) => sum + (row.precisionAt10 ?? 0), 0) / judged.length : null,
    meanReciprocalRankAt10: judged.length ? judged.reduce((sum, row) => sum + (row.reciprocalRankAt10 ?? 0), 0) / judged.length : null,
    meanNdcgAt10: judged.length ? judged.reduce((sum, row) => sum + (row.ndcgAt10 ?? 0), 0) / judged.length : null,
  };
}

/**
 * Runs serially in fixture order and preserves the adapter's ranking. No pass
 * threshold, model, database, network request, or superiority claim is built in.
 * Evaluate each retrieval mode with the same corpus and query list separately.
 */
export async function runSemanticEvaluation(
  rank: SemanticEvaluationRanker,
  options: { queries?: readonly SemanticEvaluationQuery[] } = {},
): Promise<SemanticEvaluationReport> {
  const queries = options.queries ?? SYNTHETIC_SEMANTIC_QUERIES;
  const queryIds = new Set<string>();
  for (const query of queries) {
    if (!query.id.trim() || !query.query.trim()) throw new Error("Evaluation queries require nonempty IDs and text.");
    if (queryIds.has(query.id)) throw new Error("Evaluation query IDs must be unique.");
    queryIds.add(query.id);
    validateJudgments(query.relevance);
  }

  const results: SemanticQueryResult[] = [];
  for (const query of queries) {
    let rankedIds: readonly string[];
    try {
      rankedIds = await rank(query);
    } catch {
      // An adapter may touch private diagnostics. Do not echo its arbitrary error.
      throw new Error("The semantic evaluation ranker failed; no complete report was produced.");
    }
    results.push({
      id: query.id,
      kind: query.kind,
      rankedIds: rankedIds.slice(0, CUTOFF),
      ...calculateMetricsAt10(rankedIds, query.relevance),
    });
  }

  const byKind: Partial<Record<SemanticQueryKind, SemanticMetricSummary>> = {};
  for (const kind of ["conceptual", "paraphrase", "lexical", "exact"] as const) {
    const subset = results.filter((result) => result.kind === kind);
    if (subset.length) byKind[kind] = summarize(subset);
  }
  return { ...summarize(results), results, byKind };
}
