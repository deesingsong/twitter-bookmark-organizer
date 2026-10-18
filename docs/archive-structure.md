# Local archive structure

This note records structure only. The personal archive remains local and is ignored by Git; no tweet text, identifiers, URLs, or media URLs are recorded here.

## Observed format

- One JSON file using `schemaVersion: 1`, with top-level `source`, `exportedAt`, `range.type`, `count`, and `bookmarks` fields.
- 1,406 records; the declared count matches the array length. All records use the same layout.
- Each record has an ID, status URL, full text, author object, created/bookmarked/last-seen timestamps, language, media array, metrics object, and optional quoted tweet.
- Every primary record has an ID represented as a decimal string. IDs are 18 or 19 digits; all are parseable and unique. No IDs or status URLs disagree.
- All primary records have non-empty text and valid timestamps. All have author IDs, screen names, display names, avatar URL fields, and verification booleans.
- Quote objects occur on 404 records; 1,002 records have no quote. Quote data includes text, author, timestamp, language, media, metrics, and an optional nested quote field that is null in observed data.
- 765 records reference media, with 901 media references total: 682 photos, 26 animated GIFs, and 193 videos. References contain type and media/preview/video URL fields; some video URLs are null. Media is not downloaded.
- Metrics contain bookmark, like, reply, retweet, and view counts; 3 view counts are null.
- Hashtags and external links appear within text but have no dedicated fields. Retweet metadata is not represented explicitly. The observed quote structure is one level deep.

## Data quality and compatibility

- No duplicate tweet IDs, exact duplicate URLs, or duplicate canonical status identities were found in the archive.
- No malformed IDs, status URLs, text, authors, dates, quotes, metrics, or media references were found in the observed records.
- A single versioned source adapter is sufficient for this file. The parser still reports malformed rows and within-file duplicates for future or edited archives.
- Full text is available for all observed primary bookmarks, so lexical search can use source text. Quoted text is available on 404 records. The format does not provide complete retweet metadata or a separate hashtag index.

Committed parser tests use synthetic records modeled on this structure, including string IDs beyond JavaScript's safe integer range, URL variants, media, quotes, duplicates, and invalid records.
