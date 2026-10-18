import { describe, expect, it } from "vitest";
import syntheticArchive from "@/lib/import/fixtures/twitter-bookmarks-v1.synthetic.json";
import { chunkBookmarks } from "@/lib/import/batches";
import {
  ArchiveParseError,
  NormalizedBookmarkSchema,
  parseTwitterBookmarksV1,
} from "@/lib/import/twitter-bookmarks-v1";

const source = JSON.stringify(syntheticArchive);
type MutableArchive = { [key: string]: unknown; bookmarks: Record<string, unknown>[] };
const mutableArchive = () => JSON.parse(source) as MutableArchive;

describe("Twitter bookmarks v1 adapter", () => {
  it("normalizes the observed archive shape and returns disjoint parser counts", () => {
    const parsed = parseTwitterBookmarksV1(source);

    expect(parsed.sourceFormat).toBe("twitter-bookmarks/v1");
    expect(parsed.totalSeen).toBe(4);
    expect(parsed.bookmarks).toHaveLength(2);
    expect(parsed.duplicateWithinFile).toBe(1);
    expect(parsed.invalidRecords).toEqual([{ recordIndex: 3, fields: ["id", "url"] }]);
  });

  it("keeps snowflake identifiers as strings beyond JavaScript's safe integer range", () => {
    const parsed = parseTwitterBookmarksV1(source);
    const [first, fallback] = parsed.bookmarks;

    expect(first.tweetId).toBe("9007199254740993");
    expect(typeof first.tweetId).toBe("string");
    expect(fallback.tweetId).toBe("9007199254740994");
  });

  it("canonicalizes domain variants and removes tracking from the identity URL", () => {
    const parsed = parseTwitterBookmarksV1(source);
    expect(parsed.bookmarks[0].canonicalUrl).toBe("https://x.com/i/web/status/9007199254740993");
    expect(parsed.bookmarks[0].originalUrl).toContain("mobile.twitter.com");
    expect(parsed.bookmarks[0].canonicalUrl).not.toContain("ref=");
    expect(parsed.bookmarks[1].canonicalUrl).toBe("https://x.com/i/web/status/9007199254740994");
    expect(parsed.bookmarks[1].originalUrl).toContain("www.x.com");
  });

  it("preserves observed author, quote, media, metric, and timestamp fields", () => {
    const [bookmark] = parseTwitterBookmarksV1(source).bookmarks;

    expect(bookmark.authorUsername).toBe("sample_user");
    expect(bookmark.mediaReferences).toEqual([{
      type: "photo",
      url: "https://media.example.test/synthetic-image.jpg",
      previewUrl: "https://media.example.test/synthetic-preview.jpg",
      videoUrl: null,
    }]);
    expect(bookmark.quotedTweet?.tweetId).toBe("9007199254740997");
    expect(bookmark.quotedTweet?.text).toBe("Synthetic quoted text.");
    expect(bookmark.sourceMetrics?.views).toBeNull();
    expect(bookmark.tweetCreatedAt).toBe("2024-01-02T03:04:05.000Z");
    expect(NormalizedBookmarkSchema.safeParse(bookmark).success).toBe(true);
  });

  it("splits normalized records into bounded batches without changing order", () => {
    const bookmarks = parseTwitterBookmarksV1(source).bookmarks;
    const batches = chunkBookmarks(bookmarks, { maxRecords: 1 });

    expect(batches).toHaveLength(2);
    expect(batches.flat().map((bookmark) => bookmark.tweetId)).toEqual(
      bookmarks.map((bookmark) => bookmark.tweetId),
    );
  });

  it("keeps distinct tweet IDs with identical text as separate bookmarks", () => {
    const archive = mutableArchive();
    archive.bookmarks[2] = {
      ...archive.bookmarks[2],
      id: "9007199254740995",
      text: archive.bookmarks[0].text,
      url: "https://twitter.com/third_user/status/9007199254740995",
    };

    const parsed = parseTwitterBookmarksV1(JSON.stringify(archive));
    expect(parsed.bookmarks).toHaveLength(2);
    expect(parsed.bookmarks.map((bookmark) => bookmark.tweetId)).toContain("9007199254740995");
  });

  it("rejects mismatched URL identity, malformed JSON, unsupported versions, and count mismatches", () => {
    const mismatched = mutableArchive();
    mismatched.bookmarks[0].url = "https://x.com/sample/status/9007199254740994";
    expect(parseTwitterBookmarksV1(JSON.stringify(mismatched)).invalidRecords[0].fields).toEqual(["id", "url"]);

    expect(() => parseTwitterBookmarksV1("{" )).toThrowError(
      expect.objectContaining({ code: "invalid_json" }) satisfies Partial<ArchiveParseError>,
    );

    const unsupported = { ...syntheticArchive, schemaVersion: 2 };
    expect(() => parseTwitterBookmarksV1(JSON.stringify(unsupported))).toThrowError(
      expect.objectContaining({ code: "unsupported_format" }),
    );

    const wrongCount = { ...syntheticArchive, count: 99 };
    expect(() => parseTwitterBookmarksV1(JSON.stringify(wrongCount))).toThrowError(
      expect.objectContaining({ code: "invalid_archive" }),
    );
  });
});
