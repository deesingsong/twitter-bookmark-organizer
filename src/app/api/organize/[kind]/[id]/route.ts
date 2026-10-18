import { eq } from "drizzle-orm";
import { z } from "zod";
import { withDatabase } from "@/db";
import { collections, tags } from "@/db/schema";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).nullable().optional() }).strict();
const confirmSchema = z.object({ confirm: z.literal(true) }).strict();
async function resolve(kind: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  return withDatabase(async db => {
    if (kind === "tag") return (await db.delete(tags).where(eq(tags.id, id)).returning())[0] ?? null;
    if (kind === "collection") return (await db.delete(collections).where(eq(collections.id, id)).returning())[0] ?? null;
    return null;
  });
}
export async function DELETE(request: Request, context: { params: Promise<{ kind: string; id: string }> }) {
  const body = await readJsonRequest(request, confirmSchema, 128);
  if (!body.ok) return body.response;
  const { kind, id } = await context.params;
  try { const item = await resolve(kind, id); return item ? jsonResponse({ deleted: true }) : apiError("organizer_item_not_found", 404); }
  catch { return apiError("organizer_delete_failed", 503); }
}
export async function PATCH(request: Request, context: { params: Promise<{ kind: string; id: string }> }) {
  const body = await readJsonRequest(request, schema, 2_048);
  if (!body.ok) return body.response;
  const { kind, id } = await context.params;
  if (!z.string().uuid().safeParse(id).success || !["tag", "collection"].includes(kind)) return apiError("organizer_item_not_found", 404);
  try {
    const item = await withDatabase(async db => kind === "tag"
      ? (await db.update(tags).set({ name: body.data.name }).where(eq(tags.id, id)).returning())[0]
      : (await db.update(collections).set({ name: body.data.name, description: body.data.description || null, updatedAt: new Date() }).where(eq(collections.id, id)).returning())[0]);
    return item ? jsonResponse({ item }) : apiError("organizer_item_not_found", 404);
  } catch { return apiError("organizer_save_failed", 503); }
}
