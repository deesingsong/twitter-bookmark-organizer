# Lexical search implementation

The library API keeps chronological browse mode when `q` is blank. A non-empty
query uses the following match tiers, then effective post date and bookmark UUID
for deterministic ties:

1. Tweet ID or normalized X/Twitter status URL.
2. Literal phrase, technical identifier, or exact ordinary token.
3. Weighted PostgreSQL full-text search.
4. Exact author handle or hashtag identifier.
5. Approximate pg_trgm word similarity.

The parser treats quoted strings as literal phrases, backticks as technical
literals, and recognizes IDs, supported status URLs, handles, and hashtags.
Other punctuation-bearing tokens stay intact for literal matching. Snowflake
IDs remain strings. Text and quoted text receive weight A/B, notes and tags B,
and author names C. English language rows use the English configuration;
unknown and other languages use `simple`.

Search documents are maintained by PostgreSQL triggers on source content,
notes, tag assignment/removal, and tag rename. The `search_text` trigram GIN
index is queried for plain word-only typos of at least four letters. Its
word-similarity threshold is 0.55 and the candidate set is capped at 200 after
structured filters. IDs, URLs, punctuation-heavy literals, handles, hashtags,
and phrases do not broaden into fuzzy matches.

Relevance cursors include a version and a digest of query, filters, and sort.
They carry the tier, score, effective date, and UUID ordering keys; a cursor
cannot be reused with different search settings. Search responses are private
and non-cacheable. Highlighting is rendered as escaped React text and `<mark>`
elements.

The retrieval engine is lexical only in this milestone. Embeddings, semantic
retrieval, reciprocal-rank fusion, and multilingual semantic quality are not
implemented.
