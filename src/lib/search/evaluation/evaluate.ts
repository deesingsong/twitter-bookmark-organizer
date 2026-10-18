import { SYNTHETIC_SEARCH_CASES } from "./fixtures";
import type { EvaluationPage, EvaluationRequest, SearchEvaluationCase, SearchEvaluator } from "./types";

export interface SearchCaseResult {
  caseId: string;
  retrievedIds: string[];
  /** Null for a case with no judged relevant documents. */
  recallAt10: number | null;
  reciprocalRankAt10: number | null;
  durationMs: number;
  issues: string[];
}

export interface SearchEvaluationReport {
  passed: boolean;
  queryCount: number;
  judgedQueryCount: number;
  meanRecallAt10: number | null;
  meanReciprocalRankAt10: number | null;
  results: SearchCaseResult[];
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function pageIds(page: EvaluationPage, limit: number, issues: string[]): string[] {
  const ids = page.hits.map((hit) => hit.id);
  if (ids.length > limit) issues.push("Page exceeds the requested limit.");
  if (new Set(ids).size !== ids.length) issues.push("Page contains duplicate bookmark IDs.");
  if (ids.some((id) => id.length === 0)) issues.push("Page contains an empty bookmark ID.");
  if (page.nextCursor === "") issues.push("Page returns an empty cursor instead of null.");
  return ids;
}

async function checkPagination(
  search: SearchEvaluator,
  request: EvaluationRequest,
  testCase: SearchEvaluationCase,
  firstPageIds: readonly string[],
  maxPages: number,
  issues: string[],
): Promise<void> {
  const pagination = testCase.pagination;
  if (!pagination) return;
  if (!Number.isSafeInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 10) {
    throw new Error("Evaluation pagination limit must be an integer from 1 to 10.");
  }
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let finished = false;

  for (let index = 0; index < maxPages; index++) {
    const page = await search({ ...request, limit: pagination.limit, ...(cursor ? { cursor } : {}) });
    const currentIds = pageIds(page, pagination.limit, issues);
    ids.push(...currentIds);
    if (page.nextCursor === null) {
      finished = true;
      break;
    }
    if (currentIds.length === 0 || page.nextCursor === "" || cursors.has(page.nextCursor)) {
      issues.push("Cursor traversal repeated a cursor or made no progress.");
      break;
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  if (!finished) issues.push("Cursor traversal did not terminate within its page budget.");
  if (new Set(ids).size !== ids.length) issues.push("Cursor traversal repeated a bookmark.");
  if (!equalIds([...ids].sort(), [...pagination.expectedIds].sort())) {
    issues.push("Cursor traversal omitted expected bookmarks or included unexpected bookmarks.");
  }
  if (pagination.expectedIds.length <= 10 && !equalIds(ids, firstPageIds)) {
    issues.push("Cursor traversal order differs from the single-page result order.");
  }
}

/**
 * Runs only caller-supplied searches. It never seeds, reads an archive, opens a
 * database connection, chooses a mode, or invokes an HTTP endpoint itself.
 */
export async function runSearchEvaluation(
  search: SearchEvaluator,
  options: {
    cases?: readonly SearchEvaluationCase[];
    repeatCount?: number;
    maxPages?: number;
  } = {},
): Promise<SearchEvaluationReport> {
  const cases = options.cases ?? SYNTHETIC_SEARCH_CASES;
  const repeatCount = options.repeatCount ?? 2;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isSafeInteger(repeatCount) || repeatCount < 2 || repeatCount > 10) {
    throw new Error("repeatCount must be an integer from 2 to 10.");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new Error("maxPages must be an integer from 1 to 1000.");
  }
  if (new Set(cases.map((testCase) => testCase.id)).size !== cases.length) {
    throw new Error("Evaluation case IDs must be unique.");
  }
  const results: SearchCaseResult[] = [];
  for (const testCase of cases) {
    const issues: string[] = [];
    const request: EvaluationRequest = {
      query: testCase.query,
      ...(testCase.filters ? { filters: testCase.filters } : {}),
      limit: 10,
    };
    const started = performance.now();
    let retrievedIds: string[] = [];
    try {
      retrievedIds = pageIds(await search(request), request.limit, issues);
      const topTen = retrievedIds.slice(0, 10);
      if (testCase.empty && retrievedIds.length !== 0) issues.push("Expected an empty result.");
      if (testCase.firstId && topTen[0] !== testCase.firstId) issues.push("Expected bookmark is not ranked first.");
      for (const id of testCase.requiredIds ?? []) {
        if (!topTen.includes(id)) issues.push(`Required bookmark is missing from the top ten: ${id}.`);
      }
      for (const id of testCase.excludedIds ?? []) {
        if (retrievedIds.includes(id)) issues.push(`Excluded bookmark was returned: ${id}.`);
      }
      for (const [earlier, later] of testCase.before ?? []) {
        const earlierRank = topTen.indexOf(earlier);
        const laterRank = topTen.indexOf(later);
        if (earlierRank < 0 || laterRank < 0 || earlierRank >= laterRank) {
          issues.push(`Precedence failed: ${earlier} must appear before ${later}.`);
        }
      }
      for (let repeat = 1; repeat < repeatCount; repeat++) {
        const repeatedIds = pageIds(await search(request), request.limit, issues);
        if (!equalIds(retrievedIds, repeatedIds)) issues.push("Repeated searches returned a different bookmark order.");
      }
      await checkPagination(search, request, testCase, retrievedIds, maxPages, issues);
    } catch {
      // Avoid copying credentials, URLs, or driver diagnostics from arbitrary adapters.
      issues.push("Search callback or evaluation case failed; inspect the adapter locally.");
    }
    const relevant = new Set(testCase.relevantIds);
    const topTen = retrievedIds.slice(0, 10);
    const relevantHits = new Set(topTen.filter((id) => relevant.has(id)));
    const firstRelevantIndex = topTen.findIndex((id) => relevant.has(id));
    results.push({
      caseId: testCase.id,
      retrievedIds,
      recallAt10: relevant.size === 0 ? null : relevantHits.size / relevant.size,
      reciprocalRankAt10: relevant.size === 0 ? null : firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1),
      durationMs: performance.now() - started,
      issues,
    });
  }
  const judged = results.filter((result) => result.recallAt10 !== null);
  return {
    passed: results.every((result) => result.issues.length === 0),
    queryCount: results.length,
    judgedQueryCount: judged.length,
    meanRecallAt10: judged.length === 0 ? null : judged.reduce((sum, result) => sum + result.recallAt10!, 0) / judged.length,
    meanReciprocalRankAt10: judged.length === 0 ? null : judged.reduce((sum, result) => sum + result.reciprocalRankAt10!, 0) / judged.length,
    results,
  };
}
