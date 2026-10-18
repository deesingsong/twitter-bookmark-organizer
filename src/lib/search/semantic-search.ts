import "server-only";

import { and, asc, cosineDistance, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db";
import { bookmarkEmbeddings, bookmarks, bookmarkTags, collectionBookmarks, collections, tags } from "@/db/schema";
import { EMBEDDING_CONTRACT } from "@/lib/embeddings/contracts";
import { buildBookmarkQuery } from "./bookmark-query";
import { parseSearchQuery } from "./query";
import { fuseSearchRankings, MAX_SEARCH_CANDIDATES, rankSemanticCandidates } from "./semantic-retrieval";
import { encodeSemanticCursor, type SemanticSearchInput } from "./semantic-request";

/** Every eligibility/structured predicate is inside the query's top-200 limit. */
export function semanticCandidateQuery(db: Database, input: SemanticSearchInput) {
  const { filters, sortAt } = buildBookmarkQuery(db, input, parseSearchQuery(input.q));
  const distance = sql<number>`${cosineDistance(bookmarkEmbeddings.embedding, input.queryVector)}`.mapWith(Number);
  return db.select({
    id: bookmarks.id, sortAt, cosineDistance: distance,
    status: bookmarkEmbeddings.status, modelId: bookmarkEmbeddings.modelId,
    modelRevision: bookmarkEmbeddings.modelRevision, preprocessingVersion: bookmarkEmbeddings.preprocessingVersion,
    dimensions: bookmarkEmbeddings.dimensions,
  }).from(bookmarkEmbeddings).innerJoin(bookmarks, eq(bookmarks.id, bookmarkEmbeddings.bookmarkId))
    .where(and(
      ...filters, eq(bookmarkEmbeddings.status, "ready"), isNotNull(bookmarkEmbeddings.embedding),
      isNotNull(bookmarkEmbeddings.indexedAt), eq(bookmarkEmbeddings.modelId, EMBEDDING_CONTRACT.modelId),
      eq(bookmarkEmbeddings.modelRevision, EMBEDDING_CONTRACT.modelRevision),
      eq(bookmarkEmbeddings.preprocessingVersion, EMBEDDING_CONTRACT.preprocessingVersion),
      eq(bookmarkEmbeddings.dimensions, EMBEDDING_CONTRACT.dimensions),
      sql`${distance} between 0 and 2`,
    ))
    .orderBy(asc(distance), asc(bookmarks.id)).limit(MAX_SEARCH_CANDIDATES);
}

/** Recompute bounded, cursor-independent rankings, then hydrate just the page. */
export async function searchBookmarks(db: Database, input: SemanticSearchInput, signature: string, cursorId?: string) {
  await db.execute(sql`select set_config('statement_timeout', '3000ms', false)`);
  const query = parseSearchQuery(input.q);
  const { sortAt, filters, predicate, rank, score, priorityPredicate } = buildBookmarkQuery(db, input, query);
  if (input.mode === "hybrid" && query.fuzzyText) {
    await db.execute(sql`select set_config('pg_trgm.word_similarity_threshold', '0.55', false)`);
  }
  const candidateSelection = { id: bookmarks.id, sortAt, rank, score };
  const priority = await db.select(candidateSelection).from(bookmarks).where(and(priorityPredicate, ...filters))
    .orderBy(desc(rank), desc(score), desc(sortAt), desc(bookmarks.id)).limit(MAX_SEARCH_CANDIDATES);
  const lexical = input.mode === "hybrid"
    ? await db.select(candidateSelection).from(bookmarks).where(and(predicate, ...filters))
      .orderBy(desc(rank), desc(score), desc(sortAt), desc(bookmarks.id)).limit(MAX_SEARCH_CANDIDATES)
    : [];
  const semantic = rankSemanticCandidates(await semanticCandidateQuery(db, input), { space: EMBEDDING_CONTRACT });
  const priorityIds = priority.map(({ id }) => id);
  const semanticIds = semantic.map(({ id }) => id);
  const lexicalIds = lexical.map(({ id }) => id);
  const prioritySet = new Set(priorityIds);
  const lexicalSet = new Set(lexicalIds);
  const semanticSet = new Set(semanticIds);
  const candidates = new Map([...priority, ...lexical, ...semantic].map((candidate) => [candidate.id, candidate]));

  let rankedIds: string[];
  if (input.sort === "newest") {
    // Sort the complete bounded union before truncating, including lower RRF ranks.
    rankedIds = [...priorityIds, ...[...candidates.keys()].filter((id) => !prioritySet.has(id))
      .sort((left, right) => new Date(candidates.get(right)!.sortAt).getTime() - new Date(candidates.get(left)!.sortAt).getTime()
        || (left < right ? 1 : left > right ? -1 : 0))].slice(0, MAX_SEARCH_CANDIDATES);
  } else if (input.mode === "hybrid") {
    rankedIds = fuseSearchRankings({ lexicalIds, semanticIds, priorityIds }).map(({ id }) => id);
  } else {
    rankedIds = [...priorityIds, ...semanticIds.filter((id) => !prioritySet.has(id))].slice(0, MAX_SEARCH_CANDIDATES);
  }

  const cursorIndex = cursorId ? rankedIds.indexOf(cursorId) : -1;
  if (cursorId && cursorIndex < 0) return null;
  const start = cursorIndex + 1;
  const pageIds = rankedIds.slice(start, start + input.limit);
  if (!pageIds.length) return { bookmarks: [], nextCursor: null };
  const rows = await db.select().from(bookmarks).where(inArray(bookmarks.id, pageIds));
  const [tagRows, collectionRows] = await Promise.all([
    db.select({ bookmarkId: bookmarkTags.bookmarkId, id: tags.id, name: tags.name }).from(bookmarkTags)
      .innerJoin(tags, eq(tags.id, bookmarkTags.tagId)).where(inArray(bookmarkTags.bookmarkId, pageIds)),
    db.select({ bookmarkId: collectionBookmarks.bookmarkId, id: collections.id, name: collections.name }).from(collectionBookmarks)
      .innerJoin(collections, eq(collections.id, collectionBookmarks.collectionId)).where(inArray(collectionBookmarks.bookmarkId, pageIds)),
  ]);
  const hydrated = new Map(rows.map((bookmark) => [bookmark.id, bookmark]));
  const page = pageIds.flatMap((id) => {
    const bookmark = hydrated.get(id);
    if (!bookmark) return [];
    const { searchDocument, searchText, searchIdentifiers, ...publicBookmark } = bookmark;
    void searchDocument; void searchText; void searchIdentifiers;
    const priorityMatch = priority.find((candidate) => candidate.id === id);
    const matchKind = priorityMatch ? (priorityMatch.rank >= 5 ? "exact" : priorityMatch.rank === 4 ? "literal" : "metadata")
      : lexicalSet.has(id) && semanticSet.has(id) ? "hybrid" : semanticSet.has(id) ? "semantic" : "lexical";
    return [{ ...publicBookmark, sortAt: candidates.get(id)!.sortAt, matchKind,
      tags: tagRows.filter((row) => row.bookmarkId === id).map(({ id, name }) => ({ id, name })),
      collections: collectionRows.filter((row) => row.bookmarkId === id).map(({ id, name }) => ({ id, name })),
    }];
  });
  const lastId = pageIds.at(-1)!;
  return { bookmarks: page, nextCursor: start + input.limit < rankedIds.length ? encodeSemanticCursor(signature, lastId) : null };
}
