import { rankDeterministically, runSemanticEvaluation } from "./evaluate";
import type {
  SemanticEvaluationDocument,
  SemanticEvaluationQuery,
  SemanticEvaluationReport,
} from "./types";

export type EmbeddingMatrix = readonly (readonly number[])[];

/** Keep a documented Matryoshka prefix, then normalize that retained space. */
export function truncateAndNormalize(vector: readonly number[], dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > vector.length) {
    throw new Error("Embedding dimensions must be a positive integer no larger than the source vector.");
  }
  const retained = vector.slice(0, dimensions);
  if (!retained.every(Number.isFinite)) throw new Error("Embedding vectors must contain finite values.");
  const norm = Math.sqrt(retained.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding vectors must have a finite, nonzero norm.");
  return retained.map((value) => value / norm);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) throw new Error("Embedding dimensions must be equal and nonempty.");
  if (!left.every(Number.isFinite) || !right.every(Number.isFinite)) throw new Error("Embedding vectors must contain finite values.");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error("Embedding vectors must have nonzero norms.");
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Score an in-memory embedding set against exactly the supplied judged corpus. */
export async function evaluateEmbeddingVectors(options: {
  documents: readonly SemanticEvaluationDocument[];
  queries: readonly SemanticEvaluationQuery[];
  documentVectors: EmbeddingMatrix;
  queryVectors: EmbeddingMatrix;
  dimensions: number;
}): Promise<SemanticEvaluationReport> {
  const { documents, queries, documentVectors, queryVectors, dimensions } = options;
  if (documentVectors.length !== documents.length || queryVectors.length !== queries.length) {
    throw new Error("Every evaluation document and query must have exactly one embedding.");
  }
  const docIds = new Set<string>();
  const docs = documents.map((document, index) => {
    if (docIds.has(document.id)) throw new Error("Evaluation document IDs must be unique.");
    docIds.add(document.id);
    return { id: document.id, vector: truncateAndNormalize(documentVectors[index], dimensions) };
  });
  const queryEmbeddings = queryVectors.map((vector) => truncateAndNormalize(vector, dimensions));
  for (const document of docs) {
    if (document.vector.length !== dimensions) throw new Error("Document embedding dimensions do not match the selected space.");
  }

  return runSemanticEvaluation((query) => {
    const queryIndex = queries.findIndex((candidate) => candidate.id === query.id);
    if (queryIndex < 0) throw new Error("Unknown evaluation query.");
    return rankDeterministically(docs.map((document) => ({
      id: document.id,
      score: cosineSimilarity(queryEmbeddings[queryIndex], document.vector),
    })));
  }, { queries });
}
