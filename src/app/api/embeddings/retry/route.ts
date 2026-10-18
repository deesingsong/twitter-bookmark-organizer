import { withDatabase } from "@/db";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";
import { claimEmbeddingsSchema } from "@/lib/embeddings/indexing";
import { retryFailedEmbeddings } from "@/lib/embeddings/retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJsonRequest(request, claimEmbeddingsSchema, 256);
  if (!body.ok) return body.response;
  try {
    const retried = await withDatabase((db) => retryFailedEmbeddings(db, body.data.limit));
    return jsonResponse({ retried });
  } catch {
    return apiError("embedding_index_unavailable", 503);
  }
}
