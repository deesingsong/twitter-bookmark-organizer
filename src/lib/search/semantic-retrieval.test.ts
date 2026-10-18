import { describe, expect, it } from "vitest";
import {
  fuseSearchRankings,
  HYBRID_RRF_CONSTANT,
  MAX_SEARCH_CANDIDATES,
  rankSemanticCandidates,
  type SemanticDistanceCandidate,
  type SemanticEmbeddingSpace,
} from "./semantic-retrieval";

const space: SemanticEmbeddingSpace = {
  modelId: "onnx-community/bge-small-en-v1.5-ONNX",
  modelRevision: "4a9a46c7b88fa408e650a571a1800243f26309bd",
  preprocessingVersion: "bge-small-en-v1.5-enriched-v1",
  dimensions: 384,
};

function row(id: string, cosineDistance = 0.5, changes: Partial<SemanticDistanceCandidate> = {}): SemanticDistanceCandidate {
  return { ...space, id, cosineDistance, status: "ready", ...changes };
}

describe("semantic distance candidates", () => {
  it("ranks smaller cosine distances first and breaks ties by ID without mutating rows", () => {
    const rows = Object.freeze([row("b"), row("a"), row("A"), row("best", 0), row("opposite", 2)]);
    const expected = ["best", "A", "a", "b", "opposite"];
    expect(rankSemanticCandidates(rows, { space }).map(({ id }) => id)).toEqual(expected);
    expect(rankSemanticCandidates([...rows].reverse(), { space }).map(({ id }) => id)).toEqual(expected);
    expect(rows[0].id).toBe("b");
  });

  it.each([
    { modelId: "Xenova/all-MiniLM-L6-v2" },
    { modelRevision: "different-revision" },
    { preprocessingVersion: "bge-small-en-v1.5-source-only-v1" },
    { dimensions: 768 },
  ])("excludes incompatible embedding spaces: %j", (changes) => {
    const rows = [row("incompatible", 0, changes), row("compatible", 0.8)];
    expect(rankSemanticCandidates(rows, { space, limit: 1 }).map(({ id }) => id)).toEqual(["compatible"]);
  });

  it.each(["pending", "processing", "stale", "failed"])("excludes %s embeddings even at the best distance", (status) => {
    expect(rankSemanticCandidates([row("not-ready", 0, { status }), row("ready", 1)], { space, limit: 1 })
      .map(({ id }) => id)).toEqual(["ready"]);
  });

  it("applies structured filters before limiting and preserves caller row fields", () => {
    const rows = [
      { ...row("excluded", 0), collection: "other" },
      { ...row("included-second", 0.7), collection: "selected" },
      { ...row("included-first", 0.6), collection: "selected" },
    ];
    expect(rankSemanticCandidates(rows, { space, filter: (candidate) => candidate.collection === "selected", limit: 1 }))
      .toEqual([rows[2]]);
  });

  it("excludes missing, nonfinite, and impossible distances without hiding valid rows", () => {
    const invalid = [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.1, 2.1];
    const rows = invalid.map((cosineDistance, index) => row(`invalid-${index}`, 0, { cosineDistance }));
    expect(rankSemanticCandidates([...rows, row("valid", 1)], { space, limit: 1 }).map(({ id }) => id)).toEqual(["valid"]);
  });

  it("enforces the default candidate cap, caller limits, and empty results", () => {
    const rows = Array.from({ length: MAX_SEARCH_CANDIDATES + 10 }, (_, index) => row(`id-${String(index).padStart(3, "0")}`));
    expect(rankSemanticCandidates(rows, { space })).toHaveLength(MAX_SEARCH_CANDIDATES);
    expect(rankSemanticCandidates(rows, { space, limit: 2 }).map(({ id }) => id)).toEqual(["id-000", "id-001"]);
    expect(rankSemanticCandidates(rows, { space, limit: 0 })).toEqual([]);
    expect(rankSemanticCandidates([], { space })).toEqual([]);
  });

  it("rejects missing query contracts, invalid limits, and ambiguous candidate identities", () => {
    for (const change of [{ dimensions: 768 }, { modelId: "" }, { modelRevision: " " }, { preprocessingVersion: "" }]) {
      expect(() => rankSemanticCandidates([], { space: { ...space, ...change } })).toThrow(/contract/);
    }
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SEARCH_CANDIDATES + 1]) {
      expect(() => rankSemanticCandidates([], { space, limit })).toThrow(/limit/);
    }
    expect(() => rankSemanticCandidates([row(" ")], { space })).toThrow(/nonempty/);
    expect(() => rankSemanticCandidates([row("same", 0), row("same", 1)], { space })).toThrow(/unique/);
  });
});

describe("hybrid search fusion", () => {
  it("uses one-based RRF contributions with k=60 and retains ID ties", () => {
    const result = fuseSearchRankings({ lexicalIds: ["b", "shared"], semanticIds: ["a", "shared"] });
    expect(HYBRID_RRF_CONSTANT).toBe(60);
    expect(result).toEqual([
      { id: "shared", score: 2 / 62, priorityRank: null },
      { id: "a", score: 1 / 61, priorityRank: null },
      { id: "b", score: 1 / 61, priorityRank: null },
    ]);
  });

  it.each([undefined, null, []])("retains lexical ranking when semantic results are unavailable: %j", (semanticIds) => {
    expect(fuseSearchRankings({ lexicalIds: ["z", "a", "m"], semanticIds })).toEqual([
      { id: "z", score: 1 / 61, priorityRank: null },
      { id: "a", score: 1 / 62, priorityRank: null },
      { id: "m", score: 1 / 63, priorityRank: null },
    ]);
  });

  it("keeps exact-ID, URL, username and phrase precedence ahead of strong fused hits", () => {
    const priorityIds = ["tweet-id-match", "url-match", "username-match", "phrase-match"];
    const result = fuseSearchRankings({
      lexicalIds: ["shared", "username-match"], semanticIds: ["shared", "username-match"], priorityIds,
    });
    expect(result.map(({ id }) => id)).toEqual([...priorityIds, "shared"]);
    expect(result.map(({ priorityRank }) => priorityRank)).toEqual([1, 2, 3, 4, null]);
    expect(result.find(({ id }) => id === "tweet-id-match")?.score).toBe(0);
    expect(result.find(({ id }) => id === "username-match")?.score).toBe(2 / 62);
    expect(result.filter(({ id }) => id === "username-match")).toHaveLength(1);
  });

  it("can return exact matches without a model, semantic rows, or lexical hits", () => {
    expect(fuseSearchRankings({ lexicalIds: [], semanticIds: null, priorityIds: ["exact"], candidateLimit: 0 }))
      .toEqual([{ id: "exact", score: 0, priorityRank: 1 }]);
  });

  it("applies identical filters before the branch limit and final precedence limit", () => {
    const result = fuseSearchRankings({
      lexicalIds: ["excluded", "lexical", "shared"],
      semanticIds: ["excluded", "semantic", "shared"],
      priorityIds: ["excluded", "exact"],
      filter: (id) => id !== "excluded", candidateLimit: 2, limit: 3,
    });
    expect(result.map(({ id }) => id)).toEqual(["exact", "shared", "lexical"]);
    expect(result[1].score).toBe(2 / 62);
  });

  it("retains priority candidates before the final limit even when they have low fused scores", () => {
    const result = fuseSearchRankings({
      lexicalIds: ["strong", "exact"], semanticIds: ["strong"], priorityIds: ["exact"], limit: 1,
    });
    expect(result).toEqual([{ id: "exact", score: 1 / 62, priorityRank: 1 }]);
  });

  it("bounds every retrieval branch and the output, including exact-only results", () => {
    const ids = Array.from({ length: MAX_SEARCH_CANDIDATES + 10 }, (_, index) => `id-${index}`);
    const results = fuseSearchRankings({ lexicalIds: ids, semanticIds: [...ids].reverse() });
    expect(results).toHaveLength(MAX_SEARCH_CANDIDATES);
    expect(fuseSearchRankings({ lexicalIds: ids, semanticIds: ["semantic"], candidateLimit: 1 })
      .map(({ id }) => id)).toEqual(["id-0", "semantic"]);
    expect(fuseSearchRankings({ lexicalIds: [], priorityIds: ids })).toHaveLength(MAX_SEARCH_CANDIDATES);
    expect(fuseSearchRankings({ lexicalIds: ids, limit: 0 })).toEqual([]);
  });

  it("returns the same complete ranking independently of later page slicing", () => {
    const options = { lexicalIds: ["a", "c", "b"], semanticIds: ["b", "c", "d"], priorityIds: ["exact"] };
    const ranking = fuseSearchRankings(options);
    expect([...ranking.slice(0, 2), ...ranking.slice(2, 4), ...ranking.slice(4)])
      .toEqual(fuseSearchRankings(options));
    expect(options.lexicalIds).toEqual(["a", "c", "b"]);
  });

  it("rejects invalid limits and malformed identities in every branch", () => {
    for (const limit of [-1, 1.5, Number.POSITIVE_INFINITY, MAX_SEARCH_CANDIDATES + 1]) {
      expect(() => fuseSearchRankings({ lexicalIds: [], limit })).toThrow(/limit/);
      expect(() => fuseSearchRankings({ lexicalIds: [], candidateLimit: limit })).toThrow(/limit/);
    }
    expect(() => fuseSearchRankings({ lexicalIds: ["same", "same"] })).toThrow(/unique/);
    expect(() => fuseSearchRankings({ lexicalIds: [], semanticIds: ["same", "same"] })).toThrow(/unique/);
    expect(() => fuseSearchRankings({ lexicalIds: [], priorityIds: ["same", "same"] })).toThrow(/unique/);
    expect(() => fuseSearchRankings({ lexicalIds: [], semanticIds: [" "] })).toThrow(/nonempty/);
  });
});
