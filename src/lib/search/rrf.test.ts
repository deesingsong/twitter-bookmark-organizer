import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./rrf";

describe("reciprocal rank fusion", () => {
  it("adds rank contributions from branches and orders tied scores by id", () => {
    expect(reciprocalRankFusion([["b", "a"], ["a", "c"]], { constant: 0 })).toEqual([
      { id: "a", score: 1.5 },
      { id: "b", score: 1 },
      { id: "c", score: 0.5 },
    ]);
  });

  it("applies the default constant, candidate bound, and unique branch ranks", () => {
    expect(reciprocalRankFusion([["one", "two", "three"]], { limit: 2 })).toHaveLength(2);
    expect(() => reciprocalRankFusion([["same", "same"]])).toThrow(/unique/);
    expect(() => reciprocalRankFusion([[""]])).toThrow(/nonempty/);
  });

  it("rejects invalid limits", () => {
    expect(() => reciprocalRankFusion([], { constant: -1 })).toThrow(/constant/);
    expect(() => reciprocalRankFusion([], { limit: 1.5 })).toThrow(/limit/);
  });
});
