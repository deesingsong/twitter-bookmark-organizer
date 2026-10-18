import { describe, expect, it } from "vitest";
import { enrichMissingBookmarkFields } from "@/lib/import/bookmark-enrichment";
import syntheticArchive from "@/lib/import/fixtures/twitter-bookmarks-v1.synthetic.json";
import { parseTwitterBookmarksV1 } from "@/lib/import/twitter-bookmarks-v1";

const incoming = parseTwitterBookmarksV1(JSON.stringify(syntheticArchive)).bookmarks[0];
type ExistingBookmark = Parameters<typeof enrichMissingBookmarkFields>[0];

function existingBookmark(overrides: Partial<ExistingBookmark> = {}): ExistingBookmark {
  return {
    tweetId: incoming.tweetId,
    canonicalUrl: incoming.canonicalUrl,
    originalUrl: null,
    text: "Owner's existing source snapshot",
    authorId: incoming.authorId,
    authorUsername: "existing_handle",
    authorDisplayName: incoming.authorDisplayName,
    authorAvatarUrl: incoming.authorAvatarUrl,
    authorVerified: incoming.authorVerified,
    language: incoming.language,
    tweetCreatedAt: new Date(incoming.tweetCreatedAt!),
    bookmarkedAt: new Date(incoming.bookmarkedAt!),
    lastSeenAt: new Date(incoming.lastSeenAt!),
    sourceMetrics: incoming.sourceMetrics,
    mediaReferences: incoming.mediaReferences,
    quotedTweet: incoming.quotedTweet,
    sourceMetadata: { schemaVersion: 1, localKey: "preserve" },
    hasMedia: true,
    ...overrides,
  };
}

describe("bookmark import enrichment policy", () => {
  it("fills missing source data but preserves existing content and annotation fields", () => {
    const updates = enrichMissingBookmarkFields(existingBookmark({
      originalUrl: null,
      text: null,
      authorUsername: "",
      sourceMetrics: null,
      mediaReferences: [],
      quotedTweet: null,
      hasMedia: false,
    }), incoming, new Date("2026-01-01T00:00:00.000Z"));

    expect(updates.originalUrl).toBe(incoming.originalUrl);
    expect(updates.text).toBe(incoming.text);
    expect(updates.authorUsername).toBe(incoming.authorUsername);
    expect(updates.sourceMetrics).toEqual(incoming.sourceMetrics);
    expect(updates.mediaReferences).toEqual(incoming.mediaReferences);
    expect(updates.quotedTweet).toEqual(incoming.quotedTweet);
    expect(updates.hasMedia).toBe(true);
    expect(updates.sourceMetadata).toEqual({ schemaVersion: 1, source: "synthetic-fixture", localKey: "preserve" });
    expect(updates.updatedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(updates).not.toHaveProperty("note");
  });

  it("does not overwrite populated source fields or create updates for already complete rows", () => {
    const updates = enrichMissingBookmarkFields(existingBookmark({
      originalUrl: incoming.originalUrl,
      sourceMetadata: { schemaVersion: 1, source: "synthetic-fixture", localKey: "preserve" },
    }), incoming);

    expect(updates).toEqual({});
    expect(updates).not.toHaveProperty("text");
    expect(updates).not.toHaveProperty("authorUsername");
  });

  it("does not treat PostgreSQL JSON key ordering as a source metadata change", () => {
    const updates = enrichMissingBookmarkFields(existingBookmark({
      originalUrl: incoming.originalUrl,
      sourceMetadata: { source: "synthetic-fixture", schemaVersion: 1, localKey: "preserve" },
    }), incoming);

    expect(updates).toEqual({});
  });
});
