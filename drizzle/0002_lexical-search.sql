CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "search_document" "tsvector" DEFAULT ''::tsvector NOT NULL;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "search_identifiers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "bookmarks_search_document_gin_idx" ON "bookmarks" USING gin ("search_document");--> statement-breakpoint
CREATE INDEX "bookmarks_search_text_trgm_gin_idx" ON "bookmarks" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "bookmarks_search_identifiers_gin_idx" ON "bookmarks" USING gin ("search_identifiers");--> statement-breakpoint
CREATE INDEX "bookmarks_author_username_lower_idx" ON "bookmarks" USING btree (lower("author_username"));--> statement-breakpoint
CREATE FUNCTION refresh_bookmark_search_fields(p_bookmark_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  source_row bookmarks%ROWTYPE;
  tag_names text;
  searchable_text text;
  search_config regconfig;
  search_tokens text[];
BEGIN
  SELECT * INTO source_row FROM bookmarks WHERE id = p_bookmark_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT string_agg(t.name, ' ' ORDER BY lower(t.name), t.name)
    INTO tag_names
    FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
   WHERE bt.bookmark_id = p_bookmark_id;

  searchable_text := concat_ws(' ', source_row.text, source_row.quoted_tweet->>'text',
    source_row.author_username, source_row.author_display_name, source_row.note, tag_names);
  search_config := CASE
    WHEN lower(coalesce(source_row.language, '')) ~ '^en([_-]|$)' THEN 'english'::regconfig
    ELSE 'simple'::regconfig
  END;

  SELECT coalesce(array_agg(DISTINCT lower(token[1])), ARRAY[]::text[])
    INTO search_tokens
    FROM regexp_matches(searchable_text,
      '#[[:alnum:]_]+|@[[:alnum:]_]+|\.[[:alnum:]_][[:alnum:]_+.-]*|[[:alnum:]_][[:alnum:]_+.#/-]*', 'g') AS matches(token);

  UPDATE bookmarks
     SET search_text = searchable_text,
         search_identifiers = search_tokens,
         search_document =
           setweight(to_tsvector(search_config, coalesce(source_row.text, '')), 'A') ||
           setweight(to_tsvector(search_config, coalesce(source_row.quoted_tweet->>'text', '')), 'B') ||
           setweight(to_tsvector(search_config, concat_ws(' ', source_row.note, tag_names)), 'B') ||
           setweight(to_tsvector(search_config, concat_ws(' ', source_row.author_username, source_row.author_display_name)), 'C')
   WHERE id = p_bookmark_id;
END;
$$;--> statement-breakpoint
CREATE FUNCTION bookmarks_search_fields_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_bookmark_search_fields(NEW.id);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bookmarks_search_fields_after_change
AFTER INSERT OR UPDATE OF text, quoted_tweet, author_username, author_display_name, note, language
ON bookmarks FOR EACH ROW EXECUTE FUNCTION bookmarks_search_fields_trigger();--> statement-breakpoint
CREATE FUNCTION bookmark_tags_search_fields_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.bookmark_id IS DISTINCT FROM NEW.bookmark_id) THEN
    PERFORM refresh_bookmark_search_fields(OLD.bookmark_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM refresh_bookmark_search_fields(NEW.bookmark_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bookmark_tags_search_fields_after_change
AFTER INSERT OR UPDATE OF bookmark_id, tag_id OR DELETE
ON bookmark_tags FOR EACH ROW EXECUTE FUNCTION bookmark_tags_search_fields_trigger();--> statement-breakpoint
CREATE FUNCTION tags_search_fields_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected record;
BEGIN
  FOR affected IN SELECT bookmark_id FROM bookmark_tags WHERE tag_id = NEW.id LOOP
    PERFORM refresh_bookmark_search_fields(affected.bookmark_id);
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER tags_search_fields_after_rename
AFTER UPDATE OF name ON tags FOR EACH ROW EXECUTE FUNCTION tags_search_fields_trigger();--> statement-breakpoint
DO $$
DECLARE
  existing_bookmark record;
BEGIN
  FOR existing_bookmark IN SELECT id FROM bookmarks LOOP
    PERFORM refresh_bookmark_search_fields(existing_bookmark.id);
  END LOOP;
END;
$$;
