import type { bookmarks } from "@/db/schema";
import type { NormalizedBookmark } from "@/lib/import/twitter-bookmarks-v1";

type BookmarkRow = typeof bookmarks.$inferSelect;
type ExistingBookmark = Pick<BookmarkRow,
  | "tweetId"
  | "canonicalUrl"
  | "originalUrl"
  | "text"
  | "authorId"
  | "authorUsername"
  | "authorDisplayName"
  | "authorAvatarUrl"
  | "authorVerified"
  | "language"
  | "tweetCreatedAt"
  | "bookmarkedAt"
  | "lastSeenAt"
  | "sourceMetrics"
  | "mediaReferences"
  | "quotedTweet"
  | "sourceMetadata"
  | "hasMedia"
>;

type Enrichment = Partial<Omit<BookmarkRow, "id" | "note">>;

function missing<T>(current: T | null, incoming: T | null | undefined): T | undefined {
  const isEmptyString = typeof current === "string" && current.trim() === "";
  if ((current !== null && !isEmptyString) || incoming === null || incoming === undefined) return undefined;
  return incoming;
}

function toDate(value: string | null): Date | undefined {
  return value === null ? undefined : new Date(value);
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && equalJson(leftRecord[key], rightRecord[key]));
  }
  return false;
}

export function enrichMissingBookmarkFields(
  existing: ExistingBookmark,
  incoming: NormalizedBookmark,
  now = new Date(),
): Enrichment {
  const updates: Enrichment = {};
  const fill = <K extends keyof Enrichment>(key: K, value: Enrichment[K] | undefined) => {
    if (value !== undefined) updates[key] = value;
  };

  fill("tweetId", missing(existing.tweetId, incoming.tweetId));
  fill("canonicalUrl", missing(existing.canonicalUrl, incoming.canonicalUrl));
  fill("originalUrl", missing(existing.originalUrl, incoming.originalUrl));
  fill("text", missing(existing.text, incoming.text));
  fill("authorId", missing(existing.authorId, incoming.authorId));
  fill("authorUsername", missing(existing.authorUsername, incoming.authorUsername));
  fill("authorDisplayName", missing(existing.authorDisplayName, incoming.authorDisplayName));
  fill("authorAvatarUrl", missing(existing.authorAvatarUrl, incoming.authorAvatarUrl));
  fill("authorVerified", missing(existing.authorVerified, incoming.authorVerified));
  fill("language", missing(existing.language, incoming.language));
  const tweetCreatedAt = toDate(incoming.tweetCreatedAt);
  const bookmarkedAt = toDate(incoming.bookmarkedAt);
  const lastSeenAt = toDate(incoming.lastSeenAt);
  fill("tweetCreatedAt", tweetCreatedAt ? missing(existing.tweetCreatedAt, tweetCreatedAt) : undefined);
  fill("bookmarkedAt", bookmarkedAt ? missing(existing.bookmarkedAt, bookmarkedAt) : undefined);
  fill("lastSeenAt", lastSeenAt ? missing(existing.lastSeenAt, lastSeenAt) : undefined);
  fill("sourceMetrics", missing(existing.sourceMetrics, incoming.sourceMetrics));
  if (existing.mediaReferences.length === 0 && incoming.mediaReferences.length > 0) {
    updates.mediaReferences = incoming.mediaReferences;
  }
  if (existing.quotedTweet === null && incoming.quotedTweet !== null) updates.quotedTweet = incoming.quotedTweet;
  if (!existing.hasMedia && incoming.hasMedia) updates.hasMedia = true;

  const sourceMetadata = { ...incoming.sourceMetadata, ...existing.sourceMetadata };
  if (!equalJson(sourceMetadata, existing.sourceMetadata)) {
    updates.sourceMetadata = sourceMetadata;
  }

  if (Object.keys(updates).length > 0) updates.updatedAt = now;
  return updates;
}
