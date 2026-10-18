import { describe, expect, it, vi } from "vitest";
import { generateSyntheticBenchmarkRows, runSearchBenchmark } from "./benchmark";
import { runSearchEvaluation } from "./evaluate";
import { SYNTHETIC_SEARCH_BOOKMARKS, SYNTHETIC_SEARCH_CASES } from "./fixtures";
import type { EvaluationPage, EvaluationRequest, SearchEvaluationCase } from "./types";

const testCase: SearchEvaluationCase = {
  id: "harness-example",
  query: "synthetic",
  relevantIds: ["a", "b"],
};
const page = (...ids: string[]): EvaluationPage => ({ hits: ids.map((id) => ({ id })), nextCursor: null });

describe("synthetic search evaluation harness", () => {
  it("calculates hand-checked Recall@10 and MRR@10 without counting empty judgments", async () => {
    const report = await runSearchEvaluation(async () => page("unjudged", "a"), {
      cases: [testCase, { id: "unjudged-query", query: "none", relevantIds: [] }],
    });
    expect(report.passed).toBe(true);
    expect(report.queryCount).toBe(2);
    expect(report.judgedQueryCount).toBe(1);
    expect(report.meanRecallAt10).toBe(0.5);
    expect(report.meanReciprocalRankAt10).toBe(0.5);
    expect(report.results[1].recallAt10).toBeNull();
  });

  it("does not let duplicate hits inflate recall or count rank eleven", async () => {
    const report = await runSearchEvaluation(async () => page("a", "a", "x", "y", "z", "q", "r", "s", "t", "u", "b"), { cases: [testCase] });
    expect(report.passed).toBe(false);
    expect(report.meanRecallAt10).toBe(0.5);
    expect(report.results[0].issues).toContain("Page contains duplicate bookmark IDs.");
    expect(report.results[0].issues).toContain("Page exceeds the requested limit.");
  });

  it("detects missing requirements, wrong precedence, exclusions and unexpected results", async () => {
    const report = await runSearchEvaluation(async () => page("b", "a", "excluded"), {
      cases: [{ ...testCase, firstId: "a", requiredIds: ["missing"], before: [["a", "b"]], excludedIds: ["excluded"], empty: true }],
    });
    expect(report.passed).toBe(false);
    expect(report.results[0].issues).toHaveLength(5);
  });

  it("rejects a precedence pair when one of its candidates is missing", async () => {
    const report = await runSearchEvaluation(async () => page("a"), { cases: [{ ...testCase, before: [["a", "b"]] }] });
    expect(report.passed).toBe(false);
    expect(report.results[0].issues[0]).toContain("Precedence failed");
  });

  it("detects nondeterministic ordering even when relevance metrics are unchanged", async () => {
    let calls = 0;
    const report = await runSearchEvaluation(async () => ++calls % 2 ? page("a", "b") : page("b", "a"), { cases: [testCase] });
    expect(report.meanRecallAt10).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.results[0].issues).toContain("Repeated searches returned a different bookmark order.");
  });

  it("traverses opaque cursors while retaining the original query and filters", async () => {
    const calls: EvaluationRequest[] = [];
    const report = await runSearchEvaluation(async (request) => {
      calls.push(request);
      if (request.limit === 10) return page("b", "a");
      return request.cursor ? page("a") : { hits: [{ id: "b" }], nextCursor: "opaque-next" };
    }, { cases: [{ ...testCase, filters: { tag: "synthetic-tag" }, pagination: { limit: 1, expectedIds: ["a", "b"] } }] });
    expect(report.passed).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.every((request) => request.query === "synthetic" && request.filters?.tag === "synthetic-tag")).toBe(true);
    expect(calls[3].cursor).toBe("opaque-next");
  });

  it("detects repeated bookmarks and cursor cycles within a bounded call budget", async () => {
    const search = vi.fn(async () => ({ hits: [{ id: "a" }], nextCursor: "loop" }));
    const report = await runSearchEvaluation(search, {
      cases: [{ ...testCase, pagination: { limit: 1, expectedIds: ["a", "b"] } }], maxPages: 3,
    });
    expect(report.passed).toBe(false);
    expect(search).toHaveBeenCalledTimes(4);
    expect(report.results[0].issues).toContain("Cursor traversal repeated a bookmark.");
    expect(report.results[0].issues).toContain("Cursor traversal repeated a cursor or made no progress.");
  });

  it("rejects a skipped result or a page order inconsistent with a single page", async () => {
    const report = await runSearchEvaluation(async (request) => request.limit === 10 ? page("a", "b") : page("b"), {
      cases: [{ ...testCase, pagination: { limit: 1, expectedIds: ["a", "b"] } }],
    });
    expect(report.passed).toBe(false);
    expect(report.results[0].issues).toContain("Cursor traversal omitted expected bookmarks or included unexpected bookmarks.");
    expect(report.results[0].issues).toContain("Cursor traversal order differs from the single-page result order.");
  });

  it("reports callback failure without copying arbitrary adapter diagnostics", async () => {
    const report = await runSearchEvaluation(async () => { throw new Error("private-driver-diagnostic"); }, { cases: [testCase] });
    expect(report.passed).toBe(false);
    expect(report.meanRecallAt10).toBe(0);
    expect(JSON.stringify(report)).not.toContain("private-driver-diagnostic");
  });

  it("validates call budgets and case identity", async () => {
    const search = vi.fn(async () => page());
    await expect(runSearchEvaluation(search, { repeatCount: 1 })).rejects.toThrow("repeatCount");
    await expect(runSearchEvaluation(search, { maxPages: 0 })).rejects.toThrow("maxPages");
    await expect(runSearchEvaluation(search, { cases: [testCase, testCase] })).rejects.toThrow("unique");
    expect(search).not.toHaveBeenCalled();
  });
});

describe("synthetic evaluation judgments", () => {
  it("contains 30 to 50 queries with references to synthetic records only", () => {
    expect(SYNTHETIC_SEARCH_CASES.length).toBeGreaterThanOrEqual(30);
    expect(SYNTHETIC_SEARCH_CASES.length).toBeLessThanOrEqual(50);
    expect(new Set(SYNTHETIC_SEARCH_CASES.map((entry) => entry.id)).size).toBe(SYNTHETIC_SEARCH_CASES.length);
    const ids = new Set(SYNTHETIC_SEARCH_BOOKMARKS.map((row) => row.id));
    for (const entry of SYNTHETIC_SEARCH_CASES) {
      const references = [...entry.relevantIds, ...(entry.requiredIds ?? []),
        ...(entry.excludedIds ?? []), ...(entry.firstId ? [entry.firstId] : []),
        ...(entry.before?.flat() ?? []), ...(entry.pagination?.expectedIds ?? [])];
      expect(references.every((id) => ids.has(id)), entry.id).toBe(true);
      expect(new Set(entry.relevantIds).size, entry.id).toBe(entry.relevantIds.length);
    }
    expect(SYNTHETIC_SEARCH_BOOKMARKS[0].tweetId).toBe("9007199254740993001");
    expect(SYNTHETIC_SEARCH_BOOKMARKS[1].tweetId).toBe("9007199254740993002");
  });
});

describe("synthetic search benchmark", () => {
  it.each([1000, 10000, 50000] as const)("generates exactly %i unique records and preserves the evaluation corpus", (size) => {
    const ids = new Set<string>();
    const tweetIds = new Set<string>();
    let count = 0;
    for (const row of generateSyntheticBenchmarkRows(size)) {
      if (count < SYNTHETIC_SEARCH_BOOKMARKS.length) expect(row).toEqual(SYNTHETIC_SEARCH_BOOKMARKS[count]);
      ids.add(row.id);
      tweetIds.add(row.tweetId);
      expect(typeof row.tweetId).toBe("string");
      count++;
    }
    expect(count).toBe(size);
    expect(ids.size).toBe(size);
    expect(tweetIds.size).toBe(size);
  });

  it("separates warmups from measured samples and retains per-request measurements", async () => {
    const search = vi.fn(async () => page());
    const result = await runSearchBenchmark(search, { label: "harness-only", size: 1000, iterations: 3, warmupIterations: 2, requests: [{ query: "one", limit: 10 }, { query: "two", limit: 10 }] });
    expect(search).toHaveBeenCalledTimes(10);
    expect(result.declaredRowCount).toBe(1000);
    expect(result.sampleCount).toBe(6);
    expect(result.perRequest).toHaveLength(2);
    for (const measurement of result.perRequest) {
      expect(measurement.sampleCount).toBe(3);
      expect(measurement.p50Ms).toBeGreaterThanOrEqual(0);
      expect(measurement.p95Ms).toBeGreaterThanOrEqual(measurement.p50Ms);
      expect(measurement.maxMs).toBeGreaterThanOrEqual(measurement.p95Ms);
    }
  });

  it("refuses invalid run sizes and iteration counts before calling the adapter", async () => {
    const search = vi.fn(async () => page());
    await expect(runSearchBenchmark(search, { label: "invalid", size: 1000, iterations: 0 })).rejects.toThrow("iterations");
    await expect(runSearchBenchmark(search, { label: "invalid", size: 1000, warmupIterations: -1 })).rejects.toThrow("warmupIterations");
    await expect(runSearchBenchmark(search, { label: "invalid", size: 1000, requests: [] })).rejects.toThrow("request");
    expect(search).not.toHaveBeenCalled();
  });
});
