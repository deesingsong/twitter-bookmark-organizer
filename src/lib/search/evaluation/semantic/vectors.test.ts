import { describe, expect, it } from "vitest";
import { SYNTHETIC_SEMANTIC_DOCUMENTS, SYNTHETIC_SEMANTIC_QUERIES } from "./fixtures";
import { cosineSimilarity, evaluateEmbeddingVectors, truncateAndNormalize } from "./vectors";

describe("semantic vector evaluation helpers", () => {
  it("truncates before L2 normalization", () => {
    expect(truncateAndNormalize([3, 4, 12], 2)).toEqual([0.6, 0.8]);
  });

  it("rejects malformed or zero vectors", () => {
    expect(() => truncateAndNormalize([1, Number.NaN], 2)).toThrow(/finite/);
    expect(() => truncateAndNormalize([0, 0], 2)).toThrow(/nonzero/);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/equal/);
  });

  it("evaluates identical synthetic corpus vectors deterministically", async () => {
    const vectors = SYNTHETIC_SEMANTIC_DOCUMENTS.map((_, index) => [index + 1, 1]);
    const input = {
      documents: SYNTHETIC_SEMANTIC_DOCUMENTS,
      queries: SYNTHETIC_SEMANTIC_QUERIES.slice(0, 2),
      documentVectors: vectors,
      queryVectors: [[1, 1], [1, 0]],
      dimensions: 2,
    };
    const report = await evaluateEmbeddingVectors(input);
    const repeated = await evaluateEmbeddingVectors(input);
    expect(report.queryCount).toBe(2);
    expect(report.results.map((result) => result.rankedIds)).toEqual(repeated.results.map((result) => result.rankedIds));
    expect(report.meanNdcgAt10).not.toBeNull();
  });

  it("rejects incomplete embedding matrices", async () => {
    await expect(evaluateEmbeddingVectors({
      documents: SYNTHETIC_SEMANTIC_DOCUMENTS,
      queries: SYNTHETIC_SEMANTIC_QUERIES.slice(0, 1),
      documentVectors: [],
      queryVectors: [[1, 0]],
      dimensions: 2,
    })).rejects.toThrow(/exactly one/);
  });
});
