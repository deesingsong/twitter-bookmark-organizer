import { withDatabase } from "@/db";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";
import { completeEmbedding, completeEmbeddingSchema } from "@/lib/embeddings/indexing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJsonRequest(request, completeEmbeddingSchema, 32 * 1024);
  if (!body.ok) return body.response;
  try {
    const outcome = await withDatabase((db) => completeEmbedding(db, body.data));
    if (outcome === "not_found") return apiError("embedding_claim_not_found", 404);
    if (outcome === "conflict") return apiError("embedding_claim_conflict", 409);
    return jsonResponse({ completed: true, alreadyCompleted: outcome === "already_completed" });
  } catch {
    return apiError("embedding_index_unavailable", 503);
  }
}
