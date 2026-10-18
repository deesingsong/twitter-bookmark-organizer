import { withDatabase } from "@/db";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";
import { decodeSemanticCursor, isCurrentSemanticContract, MAX_SEMANTIC_SEARCH_BYTES, semanticSearchSchema, semanticSearchSignature } from "@/lib/search/semantic-request";
import { searchBookmarks } from "@/lib/search/semantic-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJsonRequest(request, semanticSearchSchema, MAX_SEMANTIC_SEARCH_BYTES);
  if (!body.ok) return body.response;
  const input = body.data;
  if (!isCurrentSemanticContract(input.contract)) return apiError("embedding_contract_mismatch", 422);
  const signature = semanticSearchSignature(input);
  let cursorId: string | undefined;
  if (input.cursor) {
    try { cursorId = decodeSemanticCursor(input.cursor, signature); }
    catch { return apiError("invalid_cursor", 422); }
  }
  try {
    const result = await withDatabase((db) => searchBookmarks(db, input, signature, cursorId));
    return result ? jsonResponse(result) : apiError("invalid_cursor", 422);
  } catch {
    return apiError("library_unavailable", 503);
  }
}
