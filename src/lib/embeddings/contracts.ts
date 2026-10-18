/** Changing any part of this space requires reindexing existing embeddings. */
export const EMBEDDING_CONTRACT = Object.freeze({
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
} as const);

/** Only semantic content belongs here; identity and retrieval metadata do not. */
export interface EmbeddingDocumentInput {
  readonly text?: string | null;
  readonly quotedText?: string | null;
  readonly note?: string | null;
  readonly tags?: readonly string[] | null;
}

/** Validate JSON arrays and local inference output without coercing their values. */
export function validateEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value) && !(value instanceof Float32Array) && !(value instanceof Float64Array)) {
    throw new Error("Embedding vectors must be arrays of finite numbers.");
  }
  if (value.length !== EMBEDDING_CONTRACT.dimensions) {
    throw new Error(`Embedding vectors must have exactly ${EMBEDDING_CONTRACT.dimensions} dimensions.`);
  }

  // Array.from also exposes holes in sparse arrays as undefined for validation.
  const vector = Array.from(value) as unknown[];
  let nonzero = false;
  for (const component of vector) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new Error("Embedding vectors must contain only finite numbers.");
    }
    if (component !== 0) nonzero = true;
  }
  if (!nonzero) throw new Error("Embedding vectors must have a nonzero norm.");

  return vector as number[];
}

/** Scale before computing the norm to avoid overflow or underflow. */
export function normalizeEmbeddingVector(value: unknown): number[] {
  const vector = validateEmbeddingVector(value);
  const scale = Math.max(...vector.map(Math.abs));
  const scaled = vector.map((component) => component / scale);
  const norm = Math.hypot(...scaled);
  return scaled.map((component) => component / norm);
}
