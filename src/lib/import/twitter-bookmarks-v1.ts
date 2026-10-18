import { z } from "zod";
import type { SourceMediaReference } from "@/lib/import/types";

export const TWITTER_BOOKMARKS_V1 = "twitter-bookmarks/v1" as const;
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_ARCHIVE_RECORDS = 50_000;

const SnowflakeSchema = z.string().regex(/^\d{1,30}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const SafeHttpUrlSchema = z.string().url().max(4096).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
});

const AuthorSchema = z.object({
  id: SnowflakeSchema.nullable().optional(),
  screenName: z.string().max(64).nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  avatarUrl: SafeHttpUrlSchema.nullable().optional(),
  verified: z.boolean().nullable().optional(),
}).passthrough();

const MetricsSchema = z.object({
  bookmarks: z.number().int().nonnegative().nullable().optional(),
  likes: z.number().int().nonnegative().nullable().optional(),
  replies: z.number().int().nonnegative().nullable().optional(),
  retweets: z.number().int().nonnegative().nullable().optional(),
  views: z.number().int().nonnegative().nullable().optional(),
}).passthrough();

const MediaSchema = z.object({
  type: z.string().min(1).max(32),
  url: SafeHttpUrlSchema.nullable().optional(),
  previewUrl: SafeHttpUrlSchema.nullable().optional(),
  videoUrl: SafeHttpUrlSchema.nullable().optional(),
}).passthrough();

const QuoteSchema = z.object({
  id: SnowflakeSchema.nullable().optional(),
  url: z.string().max(4096).nullable().optional(),
  text: z.string().max(50_000).nullable().optional(),
  author: AuthorSchema.nullable().optional(),
  createdAt: TimestampSchema.nullable().optional(),
  lang: z.string().max(35).nullable().optional(),
  media: z.array(MediaSchema).max(100).nullable().optional(),
  metrics: MetricsSchema.nullable().optional(),
  quotedTweet: z.null().optional(),
}).passthrough();

const BookmarkSchema = z.object({
  id: SnowflakeSchema.nullable().optional(),
  url: z.string().max(4096).nullable().optional(),
  text: z.string().max(50_000).nullable().optional(),
  author: AuthorSchema.nullable().optional(),
  createdAt: TimestampSchema.nullable().optional(),
  bookmarkedAt: TimestampSchema.nullable().optional(),
  lastSeenAt: TimestampSchema.nullable().optional(),
  lang: z.string().max(35).nullable().optional(),
  media: z.array(MediaSchema).max(100).nullable().optional(),
  metrics: MetricsSchema.nullable().optional(),
  quotedTweet: QuoteSchema.nullable().optional(),
}).passthrough();

const ArchiveSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().min(1).max(100),
  exportedAt: TimestampSchema,
  range: z.object({ type: z.string().min(1).max(32) }).passthrough(),
  count: z.number().int().nonnegative().max(MAX_ARCHIVE_RECORDS),
  bookmarks: z.array(z.unknown()).max(MAX_ARCHIVE_RECORDS),
}).passthrough();

export type NormalizedQuotedTweet = {
  tweetId: string | null;
  canonicalUrl: string | null;
  text: string | null;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorVerified: boolean | null;
  language: string | null;
  tweetCreatedAt: string | null;
  mediaReferences: SourceMediaReference[];
  metrics: Record<string, number | null> | null;
};

export type NormalizedBookmark = {
  tweetId: string;
  canonicalUrl: string;
  originalUrl: string | null;
  text: string | null;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorVerified: boolean | null;
  language: string | null;
  tweetCreatedAt: string | null;
  bookmarkedAt: string | null;
  lastSeenAt: string | null;
  sourceMetrics: Record<string, number | null> | null;
  mediaReferences: SourceMediaReference[];
  quotedTweet: NormalizedQuotedTweet | null;
  sourceMetadata: Record<string, unknown>;
  hasMedia: boolean;
};

export type InvalidArchiveRecord = { recordIndex: number; fields: string[] };

export type ArchiveParseResult = {
  sourceFormat: typeof TWITTER_BOOKMARKS_V1;
  totalSeen: number;
  bookmarks: NormalizedBookmark[];
  duplicateWithinFile: number;
  invalidRecords: InvalidArchiveRecord[];
  warningRecords: InvalidArchiveRecord[];
};

const NormalizedMediaSchema = z.object({
  type: z.string().min(1).max(32),
  url: SafeHttpUrlSchema.nullable(),
  previewUrl: SafeHttpUrlSchema.nullable(),
  videoUrl: SafeHttpUrlSchema.nullable(),
}).strict();

const NormalizedMetricsSchema = z.record(z.string(), z.number().int().nonnegative().nullable());
const NormalizedAuthorFields = {
  authorId: SnowflakeSchema.nullable(),
  authorUsername: z.string().max(64).nullable(),
  authorDisplayName: z.string().max(200).nullable(),
  authorAvatarUrl: SafeHttpUrlSchema.nullable(),
  authorVerified: z.boolean().nullable(),
  language: z.string().max(35).nullable(),
};

export const NormalizedQuotedTweetSchema = z.object({
  tweetId: SnowflakeSchema.nullable(),
  canonicalUrl: z.string().url().nullable(),
  text: z.string().max(50_000).nullable(),
  ...NormalizedAuthorFields,
  tweetCreatedAt: TimestampSchema.nullable(),
  mediaReferences: z.array(NormalizedMediaSchema).max(100),
  metrics: NormalizedMetricsSchema.nullable(),
}).strict().superRefine((quote, context) => {
  const expected = quote.tweetId ? canonicalStatusUrl(quote.tweetId) : null;
  if (quote.canonicalUrl !== expected) {
    context.addIssue({ code: "custom", path: ["canonicalUrl"], message: "Invalid canonical quote URL" });
  }
});

export const NormalizedBookmarkSchema = z.object({
  tweetId: SnowflakeSchema,
  canonicalUrl: z.string().url(),
  originalUrl: z.string().max(4096).nullable(),
  text: z.string().max(50_000).nullable(),
  ...NormalizedAuthorFields,
  tweetCreatedAt: TimestampSchema.nullable(),
  bookmarkedAt: TimestampSchema.nullable(),
  lastSeenAt: TimestampSchema.nullable(),
  sourceMetrics: NormalizedMetricsSchema.nullable(),
  mediaReferences: z.array(NormalizedMediaSchema).max(100),
  quotedTweet: NormalizedQuotedTweetSchema.nullable(),
  sourceMetadata: z.object({ schemaVersion: z.literal(1), source: z.string().min(1).max(100) }).strict(),
  hasMedia: z.boolean(),
}).strict().superRefine((bookmark, context) => {
  if (bookmark.canonicalUrl !== canonicalStatusUrl(bookmark.tweetId)) {
    context.addIssue({ code: "custom", path: ["canonicalUrl"], message: "Invalid canonical bookmark URL" });
  }
  if (bookmark.originalUrl && statusIdentity(bookmark.originalUrl).id !== bookmark.tweetId) {
    context.addIssue({ code: "custom", path: ["originalUrl"], message: "Original URL does not match bookmark identity" });
  }
  if (bookmark.hasMedia !== (bookmark.mediaReferences.length > 0)) {
    context.addIssue({ code: "custom", path: ["hasMedia"], message: "Media presence does not match references" });
  }
});

export class ArchiveParseError extends Error {
  constructor(readonly code: "invalid_json" | "unsupported_format" | "invalid_archive" | "too_large") {
    super(code);
    this.name = "ArchiveParseError";
  }
}

function statusIdentity(rawUrl: string | null | undefined): { id: string | null; url: string | null } {
  if (!rawUrl) return { id: null, url: null };

  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const supportedHost = new Set([
      "x.com",
      "mobile.x.com",
      "twitter.com",
      "mobile.twitter.com",
    ]).has(host);
    const match = url.pathname.match(/\/status\/(\d{1,30})(?:\/|$)/);
    if (!supportedHost || !match || !["https:", "http:"].includes(url.protocol)) {
      return { id: null, url: null };
    }
    return { id: match[1], url: url.href };
  } catch {
    return { id: null, url: null };
  }
}

function canonicalStatusUrl(tweetId: string): string {
  return `https://x.com/i/web/status/${tweetId}`;
}

function nonempty(value: string | null | undefined): string | null {
  return value?.trim() ? value : null;
}

function mediaReferences(media: z.infer<typeof MediaSchema>[] | null | undefined): SourceMediaReference[] {
  return (media ?? []).map((item) => ({
    type: item.type,
    url: item.url ?? null,
    previewUrl: item.previewUrl ?? null,
    videoUrl: item.videoUrl ?? null,
  }));
}

function normalizedMetrics(metrics: z.infer<typeof MetricsSchema> | null | undefined): Record<string, number | null> | null {
  if (!metrics) return null;
  return Object.fromEntries(
    Object.entries(metrics).filter((entry): entry is [string, number | null] =>
      typeof entry[1] === "number" || entry[1] === null,
    ),
  );
}

function normalizeQuote(quote: z.infer<typeof QuoteSchema> | null | undefined): NormalizedQuotedTweet | null {
  if (!quote) return null;
  const status = statusIdentity(quote.url);
  const tweetId = quote.id ?? status.id;
  return {
    tweetId,
    canonicalUrl: tweetId ? canonicalStatusUrl(tweetId) : null,
    text: nonempty(quote.text),
    authorId: nonempty(quote.author?.id),
    authorUsername: nonempty(quote.author?.screenName),
    authorDisplayName: nonempty(quote.author?.name),
    authorAvatarUrl: quote.author?.avatarUrl ?? null,
    authorVerified: quote.author?.verified ?? null,
    language: nonempty(quote.lang),
    tweetCreatedAt: quote.createdAt ?? null,
    mediaReferences: mediaReferences(quote.media),
    metrics: normalizedMetrics(quote.metrics),
  };
}

function fieldNames(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.map(String).join(".") || "record"))];
}

export function parseTwitterBookmarksV1(source: string): ArchiveParseResult {
  if (new TextEncoder().encode(source).byteLength > MAX_ARCHIVE_BYTES) {
    throw new ArchiveParseError("too_large");
  }

  let json: unknown;
  try {
    json = JSON.parse(source) as unknown;
  } catch {
    throw new ArchiveParseError("invalid_json");
  }

  const parsedArchive = ArchiveSchema.safeParse(json);
  if (!parsedArchive.success) {
    const sourceVersion = json && typeof json === "object" && "schemaVersion" in json
      ? (json as { schemaVersion?: unknown }).schemaVersion
      : undefined;
    throw new ArchiveParseError(sourceVersion === 1 ? "invalid_archive" : "unsupported_format");
  }
  const archive = parsedArchive.data;
  if (archive.bookmarks.length !== archive.count) throw new ArchiveParseError("invalid_archive");

  const ids = new Set<string>();
  const urls = new Set<string>();
  const bookmarks: NormalizedBookmark[] = [];
  const invalidRecords: InvalidArchiveRecord[] = [];
  const warningRecords: InvalidArchiveRecord[] = [];
  let duplicateWithinFile = 0;

  archive.bookmarks.forEach((rawBookmark, recordIndex) => {
    const parsed = BookmarkSchema.safeParse(rawBookmark);
    if (!parsed.success) {
      invalidRecords.push({ recordIndex, fields: fieldNames(parsed.error) });
      return;
    }

    const record = parsed.data;
    const status = statusIdentity(record.url);
    if (record.id && status.id && record.id !== status.id) {
      invalidRecords.push({ recordIndex, fields: ["id", "url"] });
      return;
    }
    const tweetId = record.id ?? status.id;
    if (!tweetId) {
      invalidRecords.push({ recordIndex, fields: ["id", "url"] });
      return;
    }

    const canonicalUrl = canonicalStatusUrl(tweetId);
    if (ids.has(tweetId) || urls.has(canonicalUrl)) {
      duplicateWithinFile++;
      return;
    }
    ids.add(tweetId);
    urls.add(canonicalUrl);

    const author = record.author;
    const references = mediaReferences(record.media);
    bookmarks.push({
      tweetId,
      canonicalUrl,
      originalUrl: status.url,
      text: nonempty(record.text),
      authorId: nonempty(author?.id),
      authorUsername: nonempty(author?.screenName),
      authorDisplayName: nonempty(author?.name),
      authorAvatarUrl: author?.avatarUrl ?? null,
      authorVerified: author?.verified ?? null,
      language: nonempty(record.lang),
      tweetCreatedAt: record.createdAt ?? null,
      bookmarkedAt: record.bookmarkedAt ?? null,
      lastSeenAt: record.lastSeenAt ?? null,
      sourceMetrics: normalizedMetrics(record.metrics),
      mediaReferences: references,
      quotedTweet: normalizeQuote(record.quotedTweet),
      sourceMetadata: { schemaVersion: archive.schemaVersion, source: archive.source },
      hasMedia: references.length > 0,
    });

    if (record.url && !status.url) warningRecords.push({ recordIndex, fields: ["url"] });
  });

  return {
    sourceFormat: TWITTER_BOOKMARKS_V1,
    totalSeen: archive.bookmarks.length,
    bookmarks,
    duplicateWithinFile,
    invalidRecords,
    warningRecords,
  };
}
