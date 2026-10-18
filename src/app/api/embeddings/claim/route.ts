import { withDatabase } from "@/db";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";
import { EMBEDDING_CONTRACT } from "@/lib/embeddings/contracts";
import { claimEmbeddings, claimEmbeddingsSchema } from "@/lib/embeddings/indexing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJsonRequest(request, claimEmbeddingsSchema, 256);
  if (!body.ok) return body.response;
  try {
    const claims = await withDatabase((db) => claimEmbeddings(db, body.data.limit));
    return jsonResponse({ claims, contract: EMBEDDING_CONTRACT });
  } catch {
    return apiError("embedding_index_unavailable", 503);
  }
}
