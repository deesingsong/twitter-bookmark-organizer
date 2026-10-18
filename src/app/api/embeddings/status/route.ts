import { withDatabase } from "@/db";
import { apiError, jsonResponse } from "@/lib/api/http";
import { readEmbeddingIndexStatus } from "@/lib/embeddings/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return jsonResponse(await withDatabase(readEmbeddingIndexStatus));
  } catch {
    return apiError("embedding_index_unavailable", 503);
  }
}
