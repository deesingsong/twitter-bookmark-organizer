import { describe, expect, it } from "vitest";
import { EMBEDDING_CONTRACT, normalizeEmbeddingVector, validateEmbeddingVector } from "./contracts";

function vectorWith(...components: number[]): number[] {
  return [...components, ...Array<number>(EMBEDDING_CONTRACT.dimensions - components.length).fill(0)];
}

describe("BGE embedding contract", () => {
  it("pins the evaluated model, runtime, vector space, and preprocessing", () => {
    expect(EMBEDDING_CONTRACT).toEqual({
      modelId: "onnx-community/bge-small-en-v1.5-ONNX",
      modelRevision: "4a9a46c7b88fa408e650a571a1800243f26309bd",
      transformersJsVersion: "4.3.1",
      dtype: "q4",
      dimensions: 384,
      pooling: "cls",
      normalize: true,
      queryPrefix: "Represent this sentence for searching relevant passages: ",
      documentPrefix: "",
      preprocessingVersion: "bge-small-en-v1.5-enriched-v1",
    });
    expect(Object.isFrozen(EMBEDDING_CONTRACT)).toBe(true);
  });

  it("accepts 384 finite numbers with nonzero norm and returns a copy", () => {
    const source = vectorWith(3, -4);
    const vector = validateEmbeddingVector(source);
    expect(vector).toEqual(source);
    expect(vector).not.toBe(source);
    expect(validateEmbeddingVector(new Float32Array(source))).toEqual(source);
    expect(validateEmbeddingVector(new Float64Array(source))).toEqual(source);
  });

  it.each([0, 383, 385])("rejects %i dimensions", (length) => {
    expect(() => validateEmbeddingVector(Array<number>(length).fill(1))).toThrow(/exactly 384/);
  });

  it.each([null, undefined, "1,2,3", { length: 384 }, new Int32Array(384)])(
    "rejects values that are not floating-point arrays: %s",
    (value) => {
      expect(() => validateEmbeddingVector(value)).toThrow(/arrays/);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null, undefined])(
    "rejects a nonfinite or nonnumeric component: %s",
    (component) => {
      const source: unknown[] = vectorWith(1);
      source[1] = component;
      expect(() => validateEmbeddingVector(source)).toThrow(/finite numbers/);
    },
  );

  it("rejects sparse arrays and zero norms, including negative zero", () => {
    const sparse = Array<number>(384);
    sparse[0] = 1;
    expect(() => validateEmbeddingVector(sparse)).toThrow(/finite numbers/);
    expect(() => validateEmbeddingVector(Array<number>(384).fill(0))).toThrow(/nonzero norm/);
    expect(() => validateEmbeddingVector(Array<number>(384).fill(-0))).toThrow(/nonzero norm/);
  });

  it("L2 normalizes without modifying the input", () => {
    const source = vectorWith(3, -4);
    const normalized = normalizeEmbeddingVector(source);
    expect(normalized.slice(0, 2)).toEqual([0.6, -0.8]);
    expect(Math.hypot(...normalized)).toBeCloseTo(1, 14);
    expect(source).toEqual(vectorWith(3, -4));
  });

  it.each([Number.MIN_VALUE, 1e-300, 1e300, Number.MAX_VALUE])(
    "normalizes finite components without squared-norm overflow or underflow: %s",
    (magnitude) => {
      const normalized = normalizeEmbeddingVector(vectorWith(magnitude, -magnitude));
      expect(normalized.every(Number.isFinite)).toBe(true);
      expect(normalized[0]).toBeCloseTo(Math.SQRT1_2, 14);
      expect(normalized[1]).toBeCloseTo(-Math.SQRT1_2, 14);
      expect(Math.hypot(...normalized)).toBeCloseTo(1, 14);
    },
  );

  it("validates before attempting normalization", () => {
    expect(() => normalizeEmbeddingVector([1])).toThrow(/exactly 384/);
    expect(() => normalizeEmbeddingVector(vectorWith(Number.NaN))).toThrow(/finite/);
    expect(() => normalizeEmbeddingVector(vectorWith(0))).toThrow(/nonzero/);
  });
});
