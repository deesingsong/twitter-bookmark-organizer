import { z } from "zod";
import { withDatabase } from "@/db";
import { collections, tags } from "@/db/schema";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tag"), name: z.string().trim().min(1).max(60) }).strict(),
  z.object({ kind: z.literal("collection"), name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).nullable().optional() }).strict(),
]);

export async function GET() {
  try {
    const result = await withDatabase(async db => Promise.all([
      db.select().from(tags).orderBy(tags.name),
      db.select().from(collections).orderBy(collections.name),
    ]));
    return jsonResponse({ tags: result[0], collections: result[1] });
  } catch { return apiError("organizer_unavailable", 503); }
}

export async function POST(request: Request) {
  const body = await readJsonRequest(request, createSchema, 2_048);
  if (!body.ok) return body.response;
  try {
    if (body.data.kind === "tag") {
      const [item] = await withDatabase(async db => db.insert(tags).values({ name: body.data.name }).onConflictDoNothing().returning());
      if (!item) return apiError("tag_name_exists", 409);
      return jsonResponse({ item }, 201);
    }
    const [item] = await withDatabase(async db => db.insert(collections).values({ name: body.data.name, description: "description" in body.data ? body.data.description || null : null }).onConflictDoNothing().returning());
    if (!item) return apiError("collection_name_exists", 409);
    return jsonResponse({ item }, 201);
  } catch { return apiError("organizer_save_failed", 503); }
}
