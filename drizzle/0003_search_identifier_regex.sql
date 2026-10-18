CREATE OR REPLACE FUNCTION refresh_bookmark_search_fields(p_bookmark_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  source_row bookmarks%ROWTYPE;
  tag_names text;
  searchable_text text;
  search_config regconfig;
  search_tokens text[];
BEGIN
  SELECT * INTO source_row FROM bookmarks WHERE id = p_bookmark_id;
  IF NOT FOUND THEN RETURN; END IF;

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
DO $$
DECLARE existing_bookmark record;
BEGIN
  FOR existing_bookmark IN SELECT id FROM bookmarks LOOP
    PERFORM refresh_bookmark_search_fields(existing_bookmark.id);
  END LOOP;
END;
$$;
