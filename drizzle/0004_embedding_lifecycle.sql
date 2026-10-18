ALTER TABLE "bookmark_embeddings" DROP CONSTRAINT "bookmark_embeddings_status_check";--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD COLUMN "dimensions" integer DEFAULT 384 NOT NULL;--> statement-breakpoint
-- Existing vectors have no recorded enriched-text preprocessing contract.
ALTER TABLE "bookmark_embeddings" ADD COLUMN "preprocessing_version" text DEFAULT 'legacy-unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Preserve old vectors for replacement, but never present them as a current index.
UPDATE "bookmark_embeddings"
SET "status" = CASE WHEN "embedding" IS NULL THEN 'pending' ELSE 'stale' END,
    "indexed_at" = NULL,
    "last_error" = NULL;
--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ALTER COLUMN "preprocessing_version" SET DEFAULT 'bge-small-en-v1.5-enriched-v1';--> statement-breakpoint
CREATE INDEX "bookmark_embeddings_pending_idx" ON "bookmark_embeddings" USING btree ("status","attempt_count","bookmark_id") WHERE "bookmark_embeddings"."status" in ('pending', 'stale') and "bookmark_embeddings"."attempt_count" < 3;--> statement-breakpoint
CREATE INDEX "bookmark_embeddings_lease_expiry_idx" ON "bookmark_embeddings" USING btree ("lease_expires_at","bookmark_id") WHERE "bookmark_embeddings"."status" = 'processing';--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD CONSTRAINT "bookmark_embeddings_dimensions_check" CHECK ("bookmark_embeddings"."dimensions" = 384);--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD CONSTRAINT "bookmark_embeddings_preprocessing_version_check" CHECK (btrim("bookmark_embeddings"."preprocessing_version") <> '');--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD CONSTRAINT "bookmark_embeddings_attempt_count_check" CHECK ("bookmark_embeddings"."attempt_count" between 0 and 3);--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD CONSTRAINT "bookmark_embeddings_processing_claim_check" CHECK (
      ("bookmark_embeddings"."status" = 'processing' and "bookmark_embeddings"."claim_token" is not null
        and "bookmark_embeddings"."lease_expires_at" is not null and "bookmark_embeddings"."attempt_count" > 0)
      or ("bookmark_embeddings"."status" <> 'processing' and "bookmark_embeddings"."claim_token" is null and "bookmark_embeddings"."lease_expires_at" is null)
    );--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD CONSTRAINT "bookmark_embeddings_vector_state_check" CHECK (
      ("bookmark_embeddings"."status" <> 'pending' or "bookmark_embeddings"."embedding" is null)
      and ("bookmark_embeddings"."status" <> 'stale' or "bookmark_embeddings"."embedding" is not null)
      and ("bookmark_embeddings"."status" <> 'ready' or ("bookmark_embeddings"."embedding" is not null and "bookmark_embeddings"."indexed_at" is not null))
    );--> statement-breakpoint
ALTER TABLE "bookmark_embeddings" ADD CONSTRAINT "bookmark_embeddings_status_check" CHECK ("bookmark_embeddings"."status" in ('pending', 'processing', 'stale', 'ready', 'failed'));
--> statement-breakpoint
CREATE FUNCTION public.invalidate_bookmark_embedding(p_bookmark_id uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.bookmark_embeddings
     SET status = CASE WHEN embedding IS NULL THEN 'pending' ELSE 'stale' END,
         claim_token = NULL,
         lease_expires_at = NULL,
         attempt_count = 0,
         indexed_at = NULL,
         last_error = NULL
   WHERE bookmark_id = p_bookmark_id;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mark_bookmark_embedding_stale() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.text IS DISTINCT FROM OLD.text
     OR NEW.quoted_tweet IS DISTINCT FROM OLD.quoted_tweet
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    PERFORM public.invalidate_bookmark_embedding(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER bookmarks_mark_embedding_stale ON public.bookmarks;
--> statement-breakpoint
CREATE TRIGGER bookmarks_mark_embedding_stale
AFTER UPDATE OF text, quoted_tweet, note ON public.bookmarks
FOR EACH ROW EXECUTE FUNCTION public.mark_bookmark_embedding_stale();
--> statement-breakpoint
CREATE FUNCTION public.bookmark_tags_embedding_invalidation_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.invalidate_bookmark_embedding(OLD.bookmark_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.bookmark_id IS NOT DISTINCT FROM NEW.bookmark_id
       AND OLD.tag_id IS NOT DISTINCT FROM NEW.tag_id THEN
      RETURN NEW;
    END IF;
    IF OLD.bookmark_id IS DISTINCT FROM NEW.bookmark_id THEN
      PERFORM public.invalidate_bookmark_embedding(OLD.bookmark_id);
    END IF;
  END IF;

  PERFORM public.invalidate_bookmark_embedding(NEW.bookmark_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bookmark_tags_embedding_after_change
AFTER INSERT OR UPDATE OF bookmark_id, tag_id OR DELETE ON public.bookmark_tags
FOR EACH ROW EXECUTE FUNCTION public.bookmark_tags_embedding_invalidation_trigger();
--> statement-breakpoint
CREATE FUNCTION public.tags_embedding_invalidation_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected record;
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    FOR affected IN SELECT bookmark_id FROM public.bookmark_tags WHERE tag_id = NEW.id LOOP
      PERFORM public.invalidate_bookmark_embedding(affected.bookmark_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tags_embedding_after_rename
AFTER UPDATE OF name ON public.tags
FOR EACH ROW EXECUTE FUNCTION public.tags_embedding_invalidation_trigger();
