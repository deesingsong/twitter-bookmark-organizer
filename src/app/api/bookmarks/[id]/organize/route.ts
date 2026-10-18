import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { withDatabase } from "@/db";
import { bookmarkTags, bookmarks, collectionBookmarks } from "@/db/schema";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ kind: z.enum(["tag", "collection"]), id: z.string().uuid(), action: z.enum(["add", "remove"]) }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await readJsonRequest(request, schema, 256);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiError("bookmark_not_found", 404);
  try {
    const result = await withDatabase(async db => db.transaction(async tx => {
      const [bookmark] = await tx.select({ id: bookmarks.id }).from(bookmarks).where(eq(bookmarks.id, id)).for("update");
      if (!bookmark) return false;
      if (body.data.kind === "tag") {
        const query = tx.insert(bookmarkTags).values({ bookmarkId: id, tagId: body.data.id });
        if (body.data.action === "add") await query.onConflictDoNothing();
        else await tx.delete(bookmarkTags).where(and(eq(bookmarkTags.bookmarkId, id), eq(bookmarkTags.tagId, body.data.id)));
      } else {
        const query = tx.insert(collectionBookmarks).values({ bookmarkId: id, collectionId: body.data.id });
        if (body.data.action === "add") await query.onConflictDoNothing();
        else await tx.delete(collectionBookmarks).where(and(eq(collectionBookmarks.bookmarkId, id), eq(collectionBookmarks.collectionId, body.data.id)));
      }
      return true;
    }));
    return result ? jsonResponse({ updated: true }) : apiError("bookmark_not_found", 404);
  } catch { return apiError("organize_update_failed", 503); }
}
