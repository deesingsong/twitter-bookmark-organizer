import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SourceMediaReference } from "@/lib/import/types";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tweetId: text("tweet_id"),
    canonicalUrl: text("canonical_url"),
    originalUrl: text("original_url"),
    text: text("text"),
    authorId: text("author_id"),
    authorUsername: text("author_username"),
    authorDisplayName: text("author_display_name"),
    authorAvatarUrl: text("author_avatar_url"),
    authorVerified: boolean("author_verified"),
    language: text("language"),
    tweetCreatedAt: timestamp("tweet_created_at", { withTimezone: true }),
    bookmarkedAt: timestamp("bookmarked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    sourceMetrics: jsonb("source_metrics").$type<Record<string, number | null>>(),
    mediaReferences: jsonb("media_references").$type<SourceMediaReference[]>().notNull().default([]),
    quotedTweet: jsonb("quoted_tweet").$type<Record<string, unknown>>(),
    sourceMetadata: jsonb("source_metadata").$type<Record<string, unknown>>().notNull().default({}),
    firstImportedAt: timestamp("first_imported_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    hasMedia: boolean("has_media").notNull().default(false),
    searchDocument: tsvector("search_document").notNull().default(sql`''::tsvector`),
    searchText: text("search_text").notNull().default(""),
    searchIdentifiers: text("search_identifiers").array().notNull().default(sql`'{}'::text[]`),
  },
  (table) => [
    uniqueIndex("bookmarks_tweet_id_unique").on(table.tweetId),
    uniqueIndex("bookmarks_canonical_url_unique").on(table.canonicalUrl),
    index("bookmarks_tweet_created_at_idx").on(table.tweetCreatedAt),
    index("bookmarks_first_imported_at_idx").on(table.firstImportedAt),
    index("bookmarks_search_document_gin_idx").using("gin", table.searchDocument),
    index("bookmarks_search_text_trgm_gin_idx").using("gin", table.searchText.op("gin_trgm_ops")),
    index("bookmarks_search_identifiers_gin_idx").using("gin", table.searchIdentifiers),
    index("bookmarks_author_username_lower_idx").on(sql`lower(${table.authorUsername})`),
    check(
      "bookmarks_identity_present_check",
      sql`(${table.tweetId} is not null and ${table.tweetId} <> '') or (${table.canonicalUrl} is not null and ${table.canonicalUrl} <> '')`,
    ),
    check(
      "bookmarks_tweet_id_format_check",
      sql`${table.tweetId} is null or ${table.tweetId} ~ '^[0-9]{1,30}$'`,
    ),
  ],
);

export const tags = pgTable("tags", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: createdAt(),
});

export const bookmarkTags = pgTable(
  "bookmark_tags",
  {
    bookmarkId: uuid("bookmark_id").notNull().references(() => bookmarks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.bookmarkId, table.tagId] }),
    index("bookmark_tags_tag_id_idx").on(table.tagId),
  ],
);

export const collections = pgTable("collections", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const collectionBookmarks = pgTable(
  "collection_bookmarks",
  {
    collectionId: uuid("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    bookmarkId: uuid("bookmark_id").notNull().references(() => bookmarks.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.bookmarkId] }),
    index("collection_bookmarks_bookmark_id_idx").on(table.bookmarkId),
  ],
);

export const bookmarkEmbeddings = pgTable(
  "bookmark_embeddings",
  {
    bookmarkId: uuid("bookmark_id").primaryKey().references(() => bookmarks.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: 384 }),
    modelId: text("model_id").notNull(),
    modelRevision: text("model_revision").notNull(),
    dimensions: integer("dimensions").notNull().default(384),
    preprocessingVersion: text("preprocessing_version").notNull().default("bge-small-en-v1.5-enriched-v1"),
    contentHash: text("content_hash").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    index("bookmark_embeddings_pending_idx")
      .on(table.status, table.attemptCount, table.bookmarkId)
      .where(sql`${table.status} in ('pending', 'stale') and ${table.attemptCount} < 3`),
    index("bookmark_embeddings_lease_expiry_idx")
      .on(table.leaseExpiresAt, table.bookmarkId)
      .where(sql`${table.status} = 'processing'`),
    check("bookmark_embeddings_status_check", sql`${table.status} in ('pending', 'processing', 'stale', 'ready', 'failed')`),
    check("bookmark_embeddings_dimensions_check", sql`${table.dimensions} = 384`),
    check("bookmark_embeddings_preprocessing_version_check", sql`btrim(${table.preprocessingVersion}) <> ''`),
    check("bookmark_embeddings_attempt_count_check", sql`${table.attemptCount} between 0 and 3`),
    check("bookmark_embeddings_processing_claim_check", sql`
      (${table.status} = 'processing' and ${table.claimToken} is not null
        and ${table.leaseExpiresAt} is not null and ${table.attemptCount} > 0)
      or (${table.status} <> 'processing' and ${table.claimToken} is null and ${table.leaseExpiresAt} is null)
    `),
    check("bookmark_embeddings_vector_state_check", sql`
      (${table.status} <> 'pending' or ${table.embedding} is null)
      and (${table.status} <> 'stale' or ${table.embedding} is not null)
      and (${table.status} <> 'ready' or (${table.embedding} is not null and ${table.indexedAt} is not null))
    `),
  ],
);

export const importJobs = pgTable("import_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceFormat: text("source_format").notNull(),
  sourceFileHash: text("source_file_hash"),
  status: text("status").notNull().default("pending"),
  totalSeen: integer("total_seen").notNull().default(0),
  expectedBatches: integer("expected_batches").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  enriched: integer("enriched").notNull().default(0),
  alreadyExisting: integer("already_existing").notNull().default(0),
  duplicateWithinFile: integer("duplicate_within_file").notNull().default(0),
  invalid: integer("invalid").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("import_jobs_active_file_unique")
    .on(table.sourceFormat, table.sourceFileHash)
    .where(sql`${table.sourceFileHash} is not null and ${table.status} in ('pending', 'processing')`),
  check("import_jobs_status_check", sql`${table.status} in ('pending', 'processing', 'completed', 'failed', 'cancelled')`),
  check("import_jobs_nonnegative_counts_check", sql`
    ${table.totalSeen} >= 0 and ${table.inserted} >= 0 and ${table.enriched} >= 0
    and ${table.alreadyExisting} >= 0 and ${table.duplicateWithinFile} >= 0
    and ${table.invalid} >= 0 and ${table.failed} >= 0
  `),
  check("import_jobs_expected_batches_nonnegative_check", sql`${table.expectedBatches} >= 0`),
  check("import_jobs_outcomes_bounded_check", sql`
    ${table.inserted} + ${table.enriched} + ${table.alreadyExisting}
    + ${table.duplicateWithinFile} + ${table.invalid} + ${table.failed} <= ${table.totalSeen}
  `),
  check("import_jobs_completed_outcomes_check", sql`
    ${table.status} <> 'completed' or
    ${table.inserted} + ${table.enriched} + ${table.alreadyExisting}
    + ${table.duplicateWithinFile} + ${table.invalid} + ${table.failed} = ${table.totalSeen}
  `),
]);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id").notNull().references(() => importJobs.id, { onDelete: "cascade" }),
    batchNumber: integer("batch_number").notNull(),
    recordCount: integer("record_count").notNull(),
    status: text("status").notNull().default("pending"),
    payloadHash: text("payload_hash").notNull(),
    inserted: integer("inserted").notNull().default(0),
    enriched: integer("enriched").notNull().default(0),
    alreadyExisting: integer("already_existing").notNull().default(0),
    duplicateWithinFile: integer("duplicate_within_file").notNull().default(0),
    invalid: integer("invalid").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("import_batches_job_number_unique").on(table.jobId, table.batchNumber),
    check("import_batches_nonnegative_position_check", sql`${table.batchNumber} >= 0 and ${table.recordCount} > 0`),
    check("import_batches_payload_hash_check", sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
    check("import_batches_status_check", sql`${table.status} in ('pending', 'completed', 'failed')`),
    check("import_batches_nonnegative_counts_check", sql`
      ${table.inserted} >= 0 and ${table.enriched} >= 0 and ${table.alreadyExisting} >= 0
      and ${table.duplicateWithinFile} >= 0 and ${table.invalid} >= 0 and ${table.failed} >= 0
    `),
    check("import_batches_completed_outcomes_check", sql`
      ${table.status} <> 'completed' or
      ${table.inserted} + ${table.enriched} + ${table.alreadyExisting}
      + ${table.duplicateWithinFile} + ${table.invalid} + ${table.failed} = ${table.recordCount}
    `),
  ],
);
