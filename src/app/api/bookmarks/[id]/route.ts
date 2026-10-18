import { eq } from "drizzle-orm";
import { z } from "zod";
import { withDatabase } from "@/db";
import { bookmarks } from "@/db/schema";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const noteSchema = z.object({ note: z.string().max(10_000).nullable() }).strict();
const confirmSchema = z.object({ confirm: z.literal(true) }).strict();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return apiError("bookmark_not_found", 404);
  try {
    const row = await withDatabase(async db => (await db.select().from(bookmarks).where(eq(bookmarks.id, id)).limit(1))[0]);
    if (!row) return apiError("bookmark_not_found", 404);
    const { searchDocument, searchText, searchIdentifiers, ...publicBookmark } = row;
    void searchDocument; void searchText; void searchIdentifiers;
    return jsonResponse({ bookmark: publicBookmark });
  } catch { return apiError("bookmark_unavailable", 503); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await readJsonRequest(request, noteSchema, 12_000);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return apiError("bookmark_not_found", 404);
  try {
    const row = await withDatabase(async db => (await db.update(bookmarks).set({ note: body.data.note?.trim() || null, updatedAt: new Date() }).where(eq(bookmarks.id, id)).returning({ id: bookmarks.id, note: bookmarks.note }))[0]);
    return row ? jsonResponse({ bookmark: row }) : apiError("bookmark_not_found", 404);
  } catch { return apiError("note_save_failed", 503); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await readJsonRequest(request, confirmSchema, 128);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return apiError("bookmark_not_found", 404);
  try {
    const removed = await withDatabase(async db => (await db.delete(bookmarks).where(eq(bookmarks.id, id)).returning({ id: bookmarks.id })));
    return removed.length ? jsonResponse({ deleted: 1 }) : apiError("bookmark_not_found", 404);
  } catch { return apiError("bookmark_delete_failed", 503); }
}
