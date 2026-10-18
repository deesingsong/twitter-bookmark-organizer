CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "bookmark_embeddings" (
	"bookmark_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(384),
	"model_id" text NOT NULL,
	"model_revision" text NOT NULL,
	"content_hash" text NOT NULL,
	"indexed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	CONSTRAINT "bookmark_embeddings_status_check" CHECK ("bookmark_embeddings"."status" in ('pending', 'stale', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "bookmark_tags" (
	"bookmark_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "bookmark_tags_bookmark_id_tag_id_pk" PRIMARY KEY("bookmark_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tweet_id" text,
	"canonical_url" text,
	"original_url" text,
	"text" text,
	"author_id" text,
	"author_username" text,
	"author_display_name" text,
	"author_avatar_url" text,
	"author_verified" boolean,
	"language" text,
	"tweet_created_at" timestamp with time zone,
	"bookmarked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"source_metrics" jsonb,
	"media_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quoted_tweet" jsonb,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"has_media" boolean DEFAULT false NOT NULL,
	CONSTRAINT "bookmarks_identity_present_check" CHECK (("bookmarks"."tweet_id" is not null and "bookmarks"."tweet_id" <> '') or ("bookmarks"."canonical_url" is not null and "bookmarks"."canonical_url" <> '')),
	CONSTRAINT "bookmarks_tweet_id_format_check" CHECK ("bookmarks"."tweet_id" is null or "bookmarks"."tweet_id" ~ '^[0-9]{1,30}$')
);
--> statement-breakpoint
CREATE TABLE "collection_bookmarks" (
	"collection_id" uuid NOT NULL,
	"bookmark_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_bookmarks_collection_id_bookmark_id_pk" PRIMARY KEY("collection_id","bookmark_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"batch_number" integer NOT NULL,
	"record_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload_hash" text NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"enriched" integer DEFAULT 0 NOT NULL,
	"already_existing" integer DEFAULT 0 NOT NULL,
	"duplicate_within_file" integer DEFAULT 0 NOT NULL,
	"invalid" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_nonnegative_position_check" CHECK ("import_batches"."batch_number" >= 0 and "import_batches"."record_count" > 0),
	CONSTRAINT "import_batches_payload_hash_check" CHECK ("import_batches"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "import_batches_status_check" CHECK ("import_batches"."status" in ('pending', 'completed', 'failed')),
	CONSTRAINT "import_batches_nonnegative_counts_check" CHECK (
      "import_batches"."inserted" >= 0 and "import_batches"."enriched" >= 0 and "import_batches"."already_existing" >= 0
      and "import_batches"."duplicate_within_file" >= 0 and "import_batches"."invalid" >= 0 and "import_batches"."failed" >= 0
    ),
	CONSTRAINT "import_batches_completed_outcomes_check" CHECK (
      "import_batches"."status" <> 'completed' or
      "import_batches"."inserted" + "import_batches"."enriched" + "import_batches"."already_existing"
      + "import_batches"."duplicate_within_file" + "import_batches"."invalid" + "import_batches"."failed" = "import_batches"."record_count"
    )
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_format" text NOT NULL,
	"source_file_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_seen" integer DEFAULT 0 NOT NULL,
	"expected_batches" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"enriched" integer DEFAULT 0 NOT NULL,
	"already_existing" integer DEFAULT 0 NOT NULL,
	"duplicate_within_file" integer DEFAULT 0 NOT NULL,
	"invalid" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_status_check" CHECK ("import_jobs"."status" in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "import_jobs_nonnegative_counts_check" CHECK (
    "import_jobs"."total_seen" >= 0 and "import_jobs"."inserted" >= 0 and "import_jobs"."enriched" >= 0
    and "import_jobs"."already_existing" >= 0 and "import_jobs"."duplicate_within_file" >= 0
    and "import_jobs"."invalid" >= 0 and "import_jobs"."failed" >= 0
  ),
	CONSTRAINT "import_jobs_expected_batches_nonnegative_check" CHECK ("import_jobs"."expected_batches" >= 0),
	CONSTRAINT "import_jobs_outcomes_bounded_check" CHECK (
    "import_jobs"."inserted" + "import_jobs"."enriched" + "import_jobs"."already_existing"
    + "import_jobs"."duplicate_within_file" + "import_jobs"."invalid" + "import_jobs"."failed" <= "import_jobs"."total_seen"
  ),
	CONSTRAINT "import_jobs_completed_outcomes_check" CHECK (
    "import_jobs"."status" <> 'completed' or
    "import_jobs"."inserted" + "import_jobs"."enriched" + "import_jobs"."already_existing"
    + "import_jobs"."duplicate_within_file" + "import_jobs"."invalid" + "import_jobs"."failed" = "import_jobs"."total_seen"
  )
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD CONSTRAINT "bookmark_embeddings_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "public"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark_tags" ADD CONSTRAINT "bookmark_tags_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "public"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark_tags" ADD CONSTRAINT "bookmark_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_bookmarks" ADD CONSTRAINT "collection_bookmarks_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_bookmarks" ADD CONSTRAINT "collection_bookmarks_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "public"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_job_id_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookmark_tags_tag_id_idx" ON "bookmark_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_tweet_id_unique" ON "bookmarks" USING btree ("tweet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_canonical_url_unique" ON "bookmarks" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "bookmarks_tweet_created_at_idx" ON "bookmarks" USING btree ("tweet_created_at");--> statement-breakpoint
CREATE INDEX "bookmarks_first_imported_at_idx" ON "bookmarks" USING btree ("first_imported_at");--> statement-breakpoint
CREATE INDEX "collection_bookmarks_bookmark_id_idx" ON "collection_bookmarks" USING btree ("bookmark_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_job_number_unique" ON "import_batches" USING btree ("job_id","batch_number");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mark_bookmark_embedding_stale()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.text IS DISTINCT FROM OLD.text THEN
    UPDATE bookmark_embeddings
    SET status = CASE WHEN embedding IS NULL THEN 'pending' ELSE 'stale' END,
        indexed_at = NULL,
        last_error = NULL
    WHERE bookmark_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bookmarks_mark_embedding_stale
AFTER UPDATE OF text ON bookmarks
FOR EACH ROW
EXECUTE FUNCTION mark_bookmark_embedding_stale();