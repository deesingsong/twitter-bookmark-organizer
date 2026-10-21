import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withDatabase } from "@/db";
import { bookmarkTags, bookmarks, collectionBookmarks, collections, tags } from "@/db/schema";
import { apiError, jsonResponse } from "@/lib/api/http";
import { parseSearchQuery } from "@/lib/search/query";
import { buildBookmarkQuery, lexicalQuerySchema as querySchema } from "@/lib/search/bookmark-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const CURSOR_VERSION = 2;
function signature(f: z.infer<typeof querySchema>) {
  return createHash("sha256").update(JSON.stringify([f.q ?? "", f.author ?? "", f.from ?? "", f.to ?? "", f.media, f.tag ?? "", f.collection ?? "", f.sort, CURSOR_VERSION])).digest("hex").slice(0, 16);
}
function encodeCursor(sig: string, rank: number, score: number, at: Date | string, id: string) {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, sig, rank, score, new Date(at).toISOString(), id])).toString("base64url");
}

export async function GET(request: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return apiError("invalid_query", 422);
  const f = parsed.data;
  const query = parseSearchQuery(f.q ?? "");
  const sig = signature(f);
  let cursor: { rank: number; score: number; at: Date; id: string } | undefined;
  if (f.cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(f.cursor, "base64url").toString());
      if (!Array.isArray(value) || value.length !== 6 || value[0] !== CURSOR_VERSION || value[1] !== sig
        || typeof value[2] !== "number" || !Number.isFinite(value[2]) || typeof value[3] !== "number" || !Number.isFinite(value[3])
        || typeof value[4] !== "string" || !Number.isFinite(Date.parse(value[4])) || !z.string().uuid().safeParse(value[5]).success) throw new Error();
      cursor = { rank: value[2], score: value[3], at: new Date(value[4]), id: value[5] };
    } catch { return apiError("invalid_cursor", 422); }
  }

  try {
    const result = await withDatabase(async (db) => db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '3000ms', true)`);
      const { sortAt, filters, predicate, rank, score } = buildBookmarkQuery(tx, f, query);
      const predicates = [...(predicate ? [predicate] : []), ...filters];
      if (cursor) {
        if (f.q && f.sort === "relevance") predicates.push(or(lt(rank, cursor.rank), and(eq(rank, cursor.rank), or(lt(score, cursor.score), and(eq(score, cursor.score), or(lt(sortAt, cursor.at), and(eq(sortAt, cursor.at), lt(bookmarks.id, cursor.id)))!))!))!);
        else predicates.push(or(lt(sortAt, cursor.at), and(eq(sortAt, cursor.at), lt(bookmarks.id, cursor.id)))!);
      }
      if (query.fuzzyText) await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', '0.55', true)`);
      const rows = await tx.select({ bookmark: bookmarks, sortAt, rank, score }).from(bookmarks).where(predicates.length ? and(...predicates) : undefined)
        .orderBy(...(f.q && f.sort === "relevance" ? [desc(rank), desc(score), desc(sortAt), desc(bookmarks.id)] : [desc(sortAt), desc(bookmarks.id)]))
        .limit(f.limit + 1);
      const page = rows.slice(0, f.limit);
      const ids = page.map(({ bookmark }) => bookmark.id);
      const [tagRows, collectionRows] = await Promise.all([
        ids.length ? tx.select({ bookmarkId: bookmarkTags.bookmarkId, id: tags.id, name: tags.name }).from(bookmarkTags).innerJoin(tags, eq(tags.id, bookmarkTags.tagId)).where(inArray(bookmarkTags.bookmarkId, ids)) : Promise.resolve([]),
        ids.length ? tx.select({ bookmarkId: collectionBookmarks.bookmarkId, id: collections.id, name: collections.name }).from(collectionBookmarks).innerJoin(collections, eq(collections.id, collectionBookmarks.collectionId)).where(inArray(collectionBookmarks.bookmarkId, ids)) : Promise.resolve([]),
      ]);
      const enriched = page.map(({ bookmark, sortAt: at, rank: matchRank }) => {
        const { searchDocument, searchText, searchIdentifiers, ...publicBookmark } = bookmark;
        void searchDocument; void searchText; void searchIdentifiers;
        const matchKind = !query.normalized ? null : matchRank >= 5 ? "exact" : matchRank === 4 ? "literal" : matchRank === 3 ? "lexical" : matchRank === 2 ? "metadata" : "approximate";
        return { ...publicBookmark, sortAt: at, matchKind, tags: tagRows.filter(x => x.bookmarkId === bookmark.id).map(({ id, name }) => ({ id, name })), collections: collectionRows.filter(x => x.bookmarkId === bookmark.id).map(({ id, name }) => ({ id, name })) };
      });
      const last = page.at(-1);
      return { bookmarks: enriched, nextCursor: rows.length > f.limit && last ? encodeCursor(sig, f.q && f.sort === "relevance" ? last.rank : 0, f.q && f.sort === "relevance" ? last.score : 0, last.sortAt, last.bookmark.id) : null };
    }));
    return jsonResponse(result);
  } catch { return apiError("library_unavailable", 503); }
}
