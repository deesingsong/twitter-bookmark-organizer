import { createHash } from "node:crypto";
import { z } from "zod";
import { EMBEDDING_CONTRACT, normalizeEmbeddingVector, validateEmbeddingVector } from "@/lib/embeddings/contracts";
import { bookmarkFiltersSchema } from "./bookmark-query";

export const MAX_SEMANTIC_SEARCH_BYTES = 32 * 1024;
const CURSOR_VERSION = 1;

const queryContractSchema = z.object({
  modelId: z.string().min(1).max(200),
  modelRevision: z.string().min(1).max(128),
  transformersJsVersion: z.string().min(1).max(32),
  dtype: z.string().min(1).max(16),
  dimensions: z.number().int().min(1).max(4096),
  pooling: z.string().min(1).max(32),
  normalize: z.boolean(),
  queryPrefix: z.string().max(256),
  documentPrefix: z.string().max(256),
  preprocessingVersion: z.string().min(1).max(128),
}).strict();

export function isCurrentSemanticContract(contract: z.infer<typeof queryContractSchema>): boolean {
  return Object.keys(EMBEDDING_CONTRACT).every((key) =>
    contract[key as keyof typeof contract] === EMBEDDING_CONTRACT[key as keyof typeof EMBEDDING_CONTRACT]);
}

export const semanticSearchSchema = bookmarkFiltersSchema.extend({
  q: z.string().trim().min(1).max(300).transform((value) => value.normalize("NFC")),
  mode: z.enum(["meaning", "hybrid"]),
  contract: queryContractSchema,
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
  queryVector: z.array(z.number()).length(EMBEDDING_CONTRACT.dimensions)
    .superRefine((value, context) => {
      try {
        validateEmbeddingVector(value);
        if (Math.abs(Math.hypot(...value) - 1) > 1e-3) throw new Error();
      } catch {
        context.addIssue({ code: "custom", message: "normalized_query_vector_required" });
      }
    })
    .transform((value) => normalizeEmbeddingVector(value)),
}).strict();

export type SemanticSearchInput = z.infer<typeof semanticSearchSchema>;

/** Cursor contents contain hashes and a row ID; never a query vector or text. */
export function semanticSearchSignature(input: SemanticSearchInput): string {
  const vectorHash = createHash("sha256").update(JSON.stringify(input.queryVector)).digest("hex");
  return createHash("sha256").update(JSON.stringify([
    CURSOR_VERSION, input.q, input.mode, input.author ?? "", input.from ?? "", input.to ?? "",
    input.media, input.tag ?? "", input.collection ?? "", input.sort, input.limit,
    EMBEDDING_CONTRACT, vectorHash,
  ])).digest("hex");
}

export function encodeSemanticCursor(signature: string, id: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, signature, id])).toString("base64url");
}

export function decodeSemanticCursor(value: string, signature: string): string {
  const cursor: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== CURSOR_VERSION
    || cursor[1] !== signature || !z.string().uuid().safeParse(cursor[2]).success) {
    throw new Error("invalid_cursor");
  }
  return cursor[2] as string;
}
