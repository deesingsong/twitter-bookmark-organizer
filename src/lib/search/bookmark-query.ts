import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db";
import { bookmarkTags, bookmarks, collectionBookmarks } from "@/db/schema";
import type { ParsedSearchQuery } from "./query";

export const bookmarkFiltersSchema = z.object({
  author: z.string().trim().max(100).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  media: z.enum(["any", "yes", "no"]).default("any"),
  tag: z.string().uuid().optional(),
  collection: z.string().uuid().optional(),
  sort: z.enum(["relevance", "newest"]).default("relevance"),
});

export const lexicalQuerySchema = bookmarkFiltersSchema.extend({
  q: z.string().trim().max(300).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Shared lexical tiers and filters; fuzzy candidates are filtered before LIMIT. */
export function buildBookmarkQuery(
  db: Database,
  f: z.infer<typeof bookmarkFiltersSchema>,
  query: ParsedSearchQuery,
) {
  const sortAt = sql<Date>`coalesce(${bookmarks.tweetCreatedAt}, ${bookmarks.firstImportedAt})`;
  const identityParts = [];
  const metadataParts = [];
  if (query.tweetIds.length) identityParts.push(inArray(bookmarks.tweetId, query.tweetIds));
  if (query.canonicalUrls.length) identityParts.push(inArray(bookmarks.canonicalUrl, query.canonicalUrls));
  if (query.handles.length) {
    metadataParts.push(inArray(sql<string>`lower(${bookmarks.authorUsername})`, query.handles));
    for (const handle of query.handles) metadataParts.push(sql`${bookmarks.searchIdentifiers} @> ARRAY[${`@${handle}`} ]::text[]`);
  }
  const literalParts = [];
  const exactTermParts = [];
  for (const tweetId of query.tweetIds) literalParts.push(sql`position(${tweetId} in ${bookmarks.searchText}) > 0`);
  for (const hashtag of query.hashtags) metadataParts.push(sql`${bookmarks.searchIdentifiers} @> ARRAY[${`#${hashtag}`} ]::text[]`);
  for (const term of query.terms) exactTermParts.push(sql`${bookmarks.searchIdentifiers} @> ARRAY[${term.toLocaleLowerCase()}]::text[]`);
  for (const phrase of [...query.phrases, ...query.literals]) literalParts.push(sql`position(lower(${phrase}) in lower(${bookmarks.searchText})) > 0`);
  const ftsQuery = query.terms.length ? query.terms.join(" ") : "";
  const ftsEnglish = ftsQuery ? sql`${bookmarks.searchDocument} @@ websearch_to_tsquery('english', ${ftsQuery})` : undefined;
  const ftsSimple = ftsQuery ? sql`${bookmarks.searchDocument} @@ websearch_to_tsquery('simple', ${ftsQuery})` : undefined;
  const filters = [];
  if (f.author) filters.push(or(ilike(bookmarks.authorUsername, `%${f.author}%`), ilike(bookmarks.authorDisplayName, `%${f.author}%`))!);
  if (f.from) filters.push(sql`${bookmarks.tweetCreatedAt} >= ${new Date(`${f.from}T00:00:00.000Z`)}`);
  if (f.to) filters.push(sql`${bookmarks.tweetCreatedAt} < ${new Date(Date.parse(`${f.to}T00:00:00.000Z`) + 86_400_000)}`);
  if (f.media === "yes") filters.push(eq(bookmarks.hasMedia, true));
  if (f.media === "no") filters.push(eq(bookmarks.hasMedia, false));
  if (f.tag) filters.push(sql`exists (select 1 from ${bookmarkTags} where ${bookmarkTags.bookmarkId} = ${bookmarks.id} and ${bookmarkTags.tagId} = ${f.tag})`);
  if (f.collection) filters.push(sql`exists (select 1 from ${collectionBookmarks} where ${collectionBookmarks.bookmarkId} = ${bookmarks.id} and ${collectionBookmarks.collectionId} = ${f.collection})`);
  const fuzzy = query.fuzzyText ? sql`${query.fuzzyText} <% ${bookmarks.searchText}` : undefined;
  const fuzzyCandidates = fuzzy && query.fuzzyText ? inArray(bookmarks.id,
    db.select({ id: bookmarks.id }).from(bookmarks).where(and(fuzzy, ...filters))
      .orderBy(desc(sql`word_similarity(${query.fuzzyText}, ${bookmarks.searchText})`), desc(bookmarks.id)).limit(200)) : undefined;
  const searchParts = [...identityParts, ...literalParts, ...(exactTermParts.length ? [and(...exactTermParts)!] : []), ...metadataParts, ...(ftsEnglish ? [ftsEnglish, ftsSimple!] : []), ...(fuzzyCandidates ? [fuzzyCandidates] : [])];
  const predicate = query.normalized ? (searchParts.length ? or(...searchParts)! : sql`false`) : undefined;
  const exactRank = identityParts.length ? or(...identityParts)! : sql`false`;
  const literalRank = literalParts.length || exactTermParts.length ? or(...literalParts, ...(exactTermParts.length ? [and(...exactTermParts)!] : []))! : sql`false`;
  const ftsRank = ftsEnglish && ftsSimple ? or(ftsEnglish, ftsSimple)! : sql`false`;
  const metadataRank = metadataParts.length ? or(...metadataParts)! : sql`false`;
  const rank = sql<number>`case when ${exactRank} then 5 when ${literalRank} then 4 when ${ftsRank} then 3 when ${metadataRank} then 2 when ${fuzzyCandidates ?? sql`false`} then 1 else 0 end`;
  const handleMatches = query.handles.map((handle) => sql`lower(${bookmarks.authorUsername}) = ${handle}`);
  const handleScore = handleMatches.length ? sql`case when ${or(...handleMatches)!} then 1 else 0 end` : sql`0`;
  const score = sql<number>`case when ${rank} = 3 then greatest(ts_rank_cd(${bookmarks.searchDocument}, websearch_to_tsquery('english', ${ftsQuery || ""})), ts_rank_cd(${bookmarks.searchDocument}, websearch_to_tsquery('simple', ${ftsQuery || ""}))) when ${rank} = 2 then ${handleScore}::real when ${rank} = 1 then word_similarity(${query.fuzzyText ?? ""}, ${bookmarks.searchText}) else ${rank}::real end`;
  return { sortAt, filters, predicate, rank, score, priorityPredicate: or(exactRank, literalRank, metadataRank)! };
}
