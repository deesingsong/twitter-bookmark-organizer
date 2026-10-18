import { inArray } from "drizzle-orm";
import { z } from "zod";
import { withDatabase } from "@/db";
import { bookmarks } from "@/db/schema";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ confirm: z.literal(true), ids: z.array(z.string().uuid()).min(1).max(100) }).strict().refine(value => new Set(value.ids).size === value.ids.length);

export async function POST(request: Request) {
  const body = await readJsonRequest(request, schema, 8_192);
  if (!body.ok) return body.response;
  try {
    const deleted = await withDatabase(async db => db.transaction(async tx => tx.delete(bookmarks).where(inArray(bookmarks.id, body.data.ids)).returning({ id: bookmarks.id })));
    return jsonResponse({ deleted: deleted.length });
  } catch { return apiError("bulk_delete_failed", 503); }
}
