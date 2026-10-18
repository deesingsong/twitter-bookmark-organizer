import { describe, expect, it, vi } from "vitest";
import { calculateMetricsAt10, rankDeterministically, runSemanticEvaluation } from "./evaluate";
import { SYNTHETIC_SEMANTIC_DOCUMENTS, SYNTHETIC_SEMANTIC_QUERIES } from "./fixtures";
import type { RelevanceJudgments, SemanticEvaluationQuery } from "./types";

const example: SemanticEvaluationQuery = {
  id: "example", kind: "conceptual", query: "invented example",
  relevance: { a: 3, b: 2 }, rationale: "An explicit synthetic judgment for metric arithmetic.",
};

describe("synthetic semantic fixture", () => {
  it("contains 168 distinct invented documents and 88 independently identified queries", () => {
    expect(SYNTHETIC_SEMANTIC_DOCUMENTS).toHaveLength(168);
    expect(SYNTHETIC_SEMANTIC_QUERIES).toHaveLength(88);
    for (const field of ["id", "tweetId", "canonicalUrl", "authorUsername", "text"] as const) {
      expect(new Set(SYNTHETIC_SEMANTIC_DOCUMENTS.map((document) => document[field])).size).toBe(168);
    }
    expect(new Set(SYNTHETIC_SEMANTIC_QUERIES.map((query) => query.id)).size).toBe(88);
    for (const document of SYNTHETIC_SEMANTIC_DOCUMENTS) {
      expect(document.tweetId).toMatch(/^9900000000000000\d{3}$/);
      expect(document.canonicalUrl).toBe(`https://x.com/i/web/status/${document.tweetId}`);
      expect(document.language).toMatch(/^[a-z]{2}$/);
    }
    for (const [kind, count] of Object.entries({ conceptual: 24, paraphrase: 22, lexical: 22, exact: 20 })) {
      expect(SYNTHETIC_SEMANTIC_QUERIES.filter((query) => query.kind === kind)).toHaveLength(count);
    }
  });

  it("keeps every explicit graded judgment inside the corpus with a review rationale", () => {
    const ids = new Set(SYNTHETIC_SEMANTIC_DOCUMENTS.map((document) => document.id));
    const usedGrades = new Set<number>();
    for (const query of SYNTHETIC_SEMANTIC_QUERIES) {
      expect(query.rationale.length, query.id).toBeGreaterThan(30);
      expect(Object.keys(query.relevance).length, query.id).toBeGreaterThan(0);
      for (const [id, grade] of Object.entries(query.relevance)) {
        expect(ids.has(id), `${query.id}: ${id}`).toBe(true);
        expect([1, 2, 3], query.id).toContain(grade);
        usedGrades.add(grade);
      }
    }
    expect([...usedGrades].sort()).toEqual([1, 2, 3]);
  });

  it("checks all literal and exact judgments against their actual text or metadata", () => {
    for (const query of SYNTHETIC_SEMANTIC_QUERIES.filter((entry) => ["lexical", "exact"].includes(entry.kind))) {
      const text = query.query;
      const matches = SYNTHETIC_SEMANTIC_DOCUMENTS.filter((document) => {
        const content = [document.text, document.quotedText, document.note, ...(document.tags ?? [])].filter(Boolean).join("\n");
        if (text.startsWith('"') && text.endsWith('"')) return content.toLowerCase().includes(text.slice(1, -1).toLowerCase());
        if (text.startsWith("@")) return document.authorUsername === text.slice(1);
        if (text.startsWith("https://")) return document.canonicalUrl === text;
        if (/^\d+$/.test(text)) return document.tweetId === text;
        return content.includes(text);
      });
      expect(matches.map((document) => document.id).sort(), query.id).toEqual(Object.keys(query.relevance).sort());
    }
  });

  it("keeps quoted and owner context evidence separate from primary source text", () => {
    const evidence = [
      { queryId: "quoted-seedlings", documentId: "context-quote-1", field: "quotedText", marker: "rotating trays" },
      { queryId: "quoted-paper-bridge", documentId: "context-quote-2", field: "quotedText", marker: "paper bridge" },
      { queryId: "owner-workstation-note", documentId: "context-note-1", field: "note", marker: "standing workstation" },
      { queryId: "owner-trip-tag", documentId: "context-tags-1", field: "tags", marker: "copper-compass" },
    ] as const;
    for (const entry of evidence) {
      const query = SYNTHETIC_SEMANTIC_QUERIES.find((candidate) => candidate.id === entry.queryId)!;
      const document = SYNTHETIC_SEMANTIC_DOCUMENTS.find((candidate) => candidate.id === entry.documentId)!;
      expect(query.relevance[document.id]).toBe(3);
      expect(document.text).not.toContain(entry.marker);
      expect(document[entry.field]).toContain(entry.marker);
      expect(document).not.toHaveProperty("relevance");
      expect(document).not.toHaveProperty("rationale");
    }
  });

  it("includes labeled non-English query and document pairs without claiming model support", () => {
    const multilingual = SYNTHETIC_SEMANTIC_QUERIES.filter((query) => query.context === "multilingual");
    expect(multilingual.map((query) => query.language).sort()).toEqual(["de", "es", "fr", "ms"]);
    for (const query of multilingual) {
      for (const id of Object.keys(query.relevance)) {
        expect(SYNTHETIC_SEMANTIC_DOCUMENTS.find((document) => document.id === id)?.language).toBe(query.language);
      }
    }
  });
});

describe("semantic retrieval metrics", () => {
  it("matches hand-calculated binary recall, reciprocal rank, and graded nDCG", () => {
    const metrics = calculateMetricsAt10(["miss", "b", "a"], { a: 3, b: 1, c: 2 });
    expect(metrics.recallAt5).toBeCloseTo(2 / 3);
    expect(metrics.recallAt10).toBeCloseTo(2 / 3);
    expect(metrics.precisionAt10).toBe(2 / 10);
    expect(metrics.reciprocalRankAt10).toBe(1 / 2);
    const observed = 1 / Math.log2(3) + 7 / Math.log2(4);
    const ideal = 7 + 3 / Math.log2(3) + 1 / Math.log2(4);
    expect(metrics.ndcgAt10).toBeCloseTo(observed / ideal);
  });

  it("scores short lists with fixed-denominator precision and leaves unjudged queries unscored", () => {
    expect(calculateMetricsAt10(["a", "b", "c"], { a: 3, b: 2, c: 1 }))
      .toEqual({ recallAt5: 1, recallAt10: 1, precisionAt10: 0.3, reciprocalRankAt10: 1, ndcgAt10: 1 });
    expect(calculateMetricsAt10([], { a: 1 }))
      .toEqual({ recallAt5: 0, recallAt10: 0, precisionAt10: 0, reciprocalRankAt10: 0, ndcgAt10: 0 });
    expect(calculateMetricsAt10(["a"], {}))
      .toEqual({ recallAt5: null, recallAt10: null, precisionAt10: null, reciprocalRankAt10: null, ndcgAt10: null });
    expect(calculateMetricsAt10(["a"], { a: 3 }).precisionAt10).toBe(0.1);
  });

  it("distinguishes rank five from six and rank ten from eleven", () => {
    const metrics = calculateMetricsAt10(
      ["a", "miss-1", "miss-2", "miss-3", "miss-4", "b", "miss-5", "miss-6", "miss-7", "c", "d"],
      { a: 3, b: 2, c: 1, d: 1 },
    );
    expect(metrics.recallAt5).toBe(1 / 4);
    expect(metrics.recallAt10).toBe(3 / 4);
    expect(metrics.precisionAt10).toBe(3 / 10);
  });

  it("counts duplicate slots as wasted ranks and never brings rank eleven into the cutoff", () => {
    const metrics = calculateMetricsAt10([...Array<string>(10).fill("a"), "b"], { a: 1, b: 1 });
    expect(metrics.recallAt5).toBe(0.5);
    expect(metrics.recallAt10).toBe(0.5);
    expect(metrics.precisionAt10).toBe(0.1);
    expect(metrics.reciprocalRankAt10).toBe(1);
    expect(metrics.ndcgAt10).toBeCloseTo(1 / (1 + 1 / Math.log2(3)));
    const withGap = calculateMetricsAt10(["a", "a", "b"], { a: 1, b: 1 });
    expect(withGap.ndcgAt10).toBeCloseTo((1 + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)));
  });

  it("caps ideal gain at ten while recall still uses all relevant records", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `doc-${index}`);
    const relevance: RelevanceJudgments = Object.fromEntries(ids.map((id) => [id, 1 as const]));
    const metrics = calculateMetricsAt10(ids, relevance);
    expect(metrics.recallAt5).toBe(5 / 12);
    expect(metrics.recallAt10).toBe(10 / 12);
    expect(metrics.precisionAt10).toBe(1);
    expect(metrics.ndcgAt10).toBe(1);
  });

  it("does not mistake inherited object keys for positive judgments", () => {
    expect(calculateMetricsAt10(["toString", "constructor", "a"], { a: 3 }).reciprocalRankAt10).toBe(1 / 3);
  });

  it.each([0, -1, 4, 1.5, Number.NaN])("rejects an invalid relevance grade %s", (grade) => {
    expect(() => calculateMetricsAt10([], { a: grade } as RelevanceJudgments)).toThrow("grades");
  });
});

describe("deterministic ranking helper", () => {
  it("sorts by descending score and ordinal ID without mutating the input", () => {
    const candidates = Object.freeze([
      { id: "b", score: 0.5 }, { id: "a", score: 0.5 },
      { id: "top", score: 1 }, { id: "A", score: 0.5 },
    ]);
    expect(rankDeterministically(candidates)).toEqual(["top", "A", "a", "b"]);
    expect(rankDeterministically([...candidates].reverse(), 3)).toEqual(["top", "A", "a"]);
    expect(candidates[0].id).toBe("b");
    expect(rankDeterministically(candidates, 0)).toEqual([]);
  });

  it("fails on invalid scores, duplicate IDs, empty IDs, or invalid limits", () => {
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => rankDeterministically([{ id: "a", score }])).toThrow("finite");
    }
    expect(() => rankDeterministically([{ id: "a", score: 1 }, { id: "a", score: 2 }])).toThrow("unique");
    expect(() => rankDeterministically([{ id: " ", score: 1 }])).toThrow("nonempty");
    for (const limit of [-1, 1.5, Number.POSITIVE_INFINITY]) expect(() => rankDeterministically([], limit)).toThrow("limit");
  });
});

describe("semantic evaluation runner", () => {
  it("reports macro averages and separate query kinds, excluding unjudged queries", async () => {
    const rank = vi.fn((query: SemanticEvaluationQuery) => query.id === "example" ? ["a"] : ["miss", "b"]);
    const report = await runSemanticEvaluation(rank, { queries: [
      example,
      { ...example, id: "other", kind: "exact", relevance: { b: 3 } },
      { ...example, id: "unjudged", kind: "lexical", relevance: {} },
    ] });
    expect(rank).toHaveBeenCalledTimes(3);
    expect(report.queryCount).toBe(3);
    expect(report.judgedQueryCount).toBe(2);
    expect(report.meanRecallAt5).toBe(0.75);
    expect(report.meanRecallAt10).toBe(0.75);
    expect(report.meanPrecisionAt10).toBe(0.1);
    expect(report.meanReciprocalRankAt10).toBe(0.75);
    expect(report.meanNdcgAt10).toBeCloseTo((7 / (7 + 3 / Math.log2(3)) + 1 / Math.log2(3)) / 2);
    expect(report.byKind.conceptual?.meanRecallAt10).toBe(0.5);
    expect(report.byKind.exact?.meanPrecisionAt10).toBe(0.1);
    expect(report.byKind.lexical?.meanRecallAt5).toBeNull();
    expect(report.byKind.lexical?.meanPrecisionAt10).toBeNull();
    expect(report.byKind.lexical?.meanNdcgAt10).toBeNull();
    expect(report.results.map((result) => result.id)).toEqual(["example", "other", "unjudged"]);
  });

  it("exercises the complete fixture with an explicitly artificial ideal ranking", async () => {
    const report = await runSemanticEvaluation((query) => rankDeterministically(
      Object.entries(query.relevance).map(([id, score]) => ({ id, score })),
    ));
    expect(report.queryCount).toBe(88);
    expect(report.judgedQueryCount).toBe(88);
    const judgmentCounts = SYNTHETIC_SEMANTIC_QUERIES.map((query) => Object.keys(query.relevance).length);
    expect(report.meanRecallAt5).toBeCloseTo(judgmentCounts.reduce((sum, count) => sum + Math.min(5, count) / count, 0) / 88);
    expect(report.meanPrecisionAt10).toBeCloseTo(judgmentCounts.reduce((sum, count) => sum + count, 0) / 880);
    expect(report.meanRecallAt10).toBe(1);
    expect(report.meanReciprocalRankAt10).toBe(1);
    expect(report.meanNdcgAt10).toBe(1);
    expect(report.byKind.conceptual?.queryCount).toBe(24);
    expect(report.byKind.exact?.queryCount).toBe(20);
  });

  it("validates the complete query list before calling the ranker", async () => {
    const rank = vi.fn(() => []);
    await expect(runSemanticEvaluation(rank, { queries: [example, example] })).rejects.toThrow("unique");
    await expect(runSemanticEvaluation(rank, { queries: [{ ...example, query: " " }] })).rejects.toThrow("nonempty");
    await expect(runSemanticEvaluation(rank, { queries: [{ ...example, relevance: { "": 1 } }] })).rejects.toThrow("nonempty");
    expect(rank).not.toHaveBeenCalled();
    const empty = await runSemanticEvaluation(rank, { queries: [] });
    expect(empty.queryCount).toBe(0);
    expect(empty.meanRecallAt5).toBeNull();
    expect(empty.meanRecallAt10).toBeNull();
    expect(empty.meanPrecisionAt10).toBeNull();
  });

  it("fails the run without echoing arbitrary adapter diagnostics", async () => {
    const rank = () => { throw new Error("private driver diagnostic"); };
    await expect(runSemanticEvaluation(rank, { queries: [example] })).rejects.toThrow("no complete report");
    await expect(runSemanticEvaluation(rank, { queries: [example] })).rejects.not.toThrow("private driver diagnostic");
  });
});
