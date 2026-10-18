import type { SearchEvaluationCase, SyntheticSearchBookmark } from "./types";

function fixtureId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export const SEARCH_FIXTURE_IDS = {
  exact: fixtureId(1),
  neighbor: fixtureId(2),
  idMention: fixtureId(3),
  compilerLiteral: fixtureId(4),
  compilerStem: fixtureId(5),
  compilerTypo: fixtureId(6),
  phrase: fixtureId(7),
  phraseReordered: fixtureId(8),
  phraseNote: fixtureId(9),
  author: fixtureId(10),
  handleMention: fixtureId(11),
  annotation: fixtureId(12),
  tagged: fixtureId(13),
  token: fixtureId(14),
  nontext: fixtureId(15),
  unrelated: fixtureId(16),
  snapshotOne: fixtureId(17),
  snapshotTwo: fixtureId(18),
  snapshotThree: fixtureId(19),
  snapshotFour: fixtureId(20),
  snapshotFive: fixtureId(21),
  snapshotSix: fixtureId(22),
  unknownDate: fixtureId(23),
  multilingual: fixtureId(24),
} as const;

const ids = SEARCH_FIXTURE_IDS;

function bookmark(
  index: number,
  text: string | null,
  overrides: Partial<SyntheticSearchBookmark> = {},
): SyntheticSearchBookmark {
  // Intentionally exceed Number.MAX_SAFE_INTEGER. Never convert these to Number.
  const tweetId = `9007199254740993${String(index).padStart(3, "0")}`;
  return {
    id: fixtureId(index),
    tweetId,
    canonicalUrl: `https://x.com/i/web/status/${tweetId}`,
    text,
    authorUsername: "synthetic_writer",
    note: "",
    tags: [],
    collections: [],
    tweetCreatedAt: "2025-03-15T12:00:00.000Z",
    hasMedia: false,
    language: "en",
    ...overrides,
  };
}

/** Invented posts and annotations; no personal archive data or real vectors. */
export const SYNTHETIC_SEARCH_BOOKMARKS: readonly SyntheticSearchBookmark[] = [
  bookmark(1, "Stable identifiers survive repeated imports.", { authorUsername: "identity_lab" }),
  bookmark(2, "An adjacent identifier belongs to a separate post.", { authorUsername: "identity_lab" }),
  bookmark(3, "Reference number 9007199254740993001 appears in this invented example."),
  bookmark(4, "Compilers transform source code into executable instructions."),
  bookmark(5, "A compiler transforms a source program into executable instructions."),
  bookmark(6, "Compilres transform source code into executable instructions."),
  bookmark(7, "A transaction retry should preserve the original request identity.", {
    authorUsername: "retry_lab", tags: ["reliability"], collections: ["engineering"],
  }),
  bookmark(8, "A retry needs an identity before a transaction can finish.", {
    authorUsername: "retry_lab", tags: ["reliability"], collections: ["engineering"],
  }),
  bookmark(9, "Request processing checklist.", { note: "Document a transaction retry with bounded backoff." }),
  bookmark(10, "Designing accessible controls for keyboards.", { authorUsername: "access_lab" }),
  bookmark(11, "Thanks to @access_lab for the keyboard navigation checklist."),
  bookmark(12, "A short invented laboratory note.", {
    note: "Amberneedle describes an owner-only annotation.",
    tags: ["annotation"], collections: ["research"],
  }),
  bookmark(13, "A small invented reading list.", {
    tags: ["zirconlabel"], collections: ["reading"],
  }),
  bookmark(14, "MiniLM-L6-v2 and C++ are technical strings; snake_case stays readable."),
  bookmark(15, null, { authorUsername: "metadata_only", tweetCreatedAt: null, language: null }),
  bookmark(16, "A paper kite drifts above a quiet lake."),
  ...Array.from({ length: 6 }, (_, index) => bookmark(17 + index,
    "Snapshot pagination preserves every matching record.", {
      authorUsername: index < 3 ? "page_alpha" : "page_beta",
      tags: index % 2 === 0 ? ["page_even"] : ["page_odd"],
      collections: index < 4 ? ["page_primary"] : ["page_secondary"],
      // Equal timestamps deliberately force the target to use a stable final tie-break.
      tweetCreatedAt: "2025-04-01T12:00:00.000Z",
    })),
  bookmark(23, "Undated snapshot material.", { tweetCreatedAt: null }),
  bookmark(24, "Recherche multilingue sans promesse de pertinence anglaise.", { language: "fr" }),
];

const snapshotIds = [ids.snapshotOne, ids.snapshotTwo, ids.snapshotThree,
  ids.snapshotFour, ids.snapshotFive, ids.snapshotSix];

/**
 * Ranking invariants are distinct from relevance judgments. Unlisted hits are
 * unjudged, rather than automatically irrelevant. Quoted queries require phrases.
 */
export const SYNTHETIC_SEARCH_CASES: readonly SearchEvaluationCase[] = [
  { id: "exact-id-precision", query: "9007199254740993001", relevantIds: [ids.exact], firstId: ids.exact },
  { id: "exact-neighbor-precision", query: "9007199254740993002", relevantIds: [ids.neighbor], firstId: ids.neighbor },
  { id: "exact-before-id-mention", query: "9007199254740993001", relevantIds: [ids.exact, ids.idMention], before: [[ids.exact, ids.idMention]] },
  { id: "canonical-url", query: "https://x.com/i/web/status/9007199254740993001", relevantIds: [ids.exact], firstId: ids.exact },
  { id: "twitter-url", query: "https://twitter.com/identity_lab/status/9007199254740993001", relevantIds: [ids.exact], firstId: ids.exact },
  { id: "mobile-tracked-url", query: "https://mobile.twitter.com/identity_lab/status/9007199254740993001?s=20", relevantIds: [ids.exact], firstId: ids.exact },
  { id: "x-tracked-url", query: "https://www.x.com/identity_lab/status/9007199254740993001?ref=synthetic", relevantIds: [ids.exact], firstId: ids.exact },
  { id: "exact-handle", query: "@access_lab", relevantIds: [ids.author, ids.handleMention], firstId: ids.author },
  { id: "handle-case", query: "@ACCESS_LAB", relevantIds: [ids.author], firstId: ids.author },
  { id: "metadata-only-handle", query: "@metadata_only", relevantIds: [ids.nontext], firstId: ids.nontext },
  { id: "quoted-phrase", query: '"transaction retry"', relevantIds: [ids.phrase, ids.phraseNote], requiredIds: [ids.phrase], excludedIds: [ids.phraseReordered] },
  { id: "quoted-phrase-case", query: '"TRANSACTION RETRY"', relevantIds: [ids.phrase, ids.phraseNote], requiredIds: [ids.phrase], excludedIds: [ids.phraseReordered] },
  { id: "literal-before-stem", query: "compilers", relevantIds: [ids.compilerLiteral, ids.compilerStem], before: [[ids.compilerLiteral, ids.compilerStem]] },
  { id: "fts-before-fuzzy", query: "compilers", relevantIds: [ids.compilerLiteral, ids.compilerStem, ids.compilerTypo], before: [[ids.compilerStem, ids.compilerTypo]] },
  { id: "singular-literal-before-plural", query: "compiler", relevantIds: [ids.compilerLiteral, ids.compilerStem], firstId: ids.compilerStem },
  { id: "fuzzy-transposition", query: "compilres", relevantIds: [ids.compilerLiteral, ids.compilerStem, ids.compilerTypo], firstId: ids.compilerTypo, requiredIds: [ids.compilerLiteral] },
  { id: "fts-word-order", query: "retry transaction", relevantIds: [ids.phrase, ids.phraseReordered, ids.phraseNote], requiredIds: [ids.phrase, ids.phraseReordered] },
  { id: "fts-stemming", query: "transforming", relevantIds: [ids.compilerLiteral, ids.compilerStem], requiredIds: [ids.compilerLiteral, ids.compilerStem] },
  { id: "owner-note", query: "amberneedle", relevantIds: [ids.annotation], firstId: ids.annotation },
  { id: "owner-tag", query: "zirconlabel", relevantIds: [ids.tagged], firstId: ids.tagged },
  { id: "technical-model-name", query: "MiniLM-L6-v2", relevantIds: [ids.token], firstId: ids.token },
  { id: "technical-punctuation", query: '"C++"', relevantIds: [ids.token], firstId: ids.token },
  { id: "technical-underscore", query: "snake_case", relevantIds: [ids.token], firstId: ids.token },
  { id: "no-match", query: "xqzv_no_fixture_match_7291", relevantIds: [], empty: true },
  { id: "author-filter", query: "snapshot", filters: { author: "page_alpha" }, relevantIds: snapshotIds.slice(0, 3), requiredIds: snapshotIds.slice(0, 3), excludedIds: snapshotIds.slice(3).concat(ids.unknownDate) },
  { id: "tag-filter", query: "snapshot", filters: { tag: "page_even" }, relevantIds: [ids.snapshotOne, ids.snapshotThree, ids.snapshotFive], requiredIds: [ids.snapshotOne, ids.snapshotThree, ids.snapshotFive], excludedIds: [ids.snapshotTwo, ids.snapshotFour, ids.snapshotSix, ids.unknownDate] },
  { id: "collection-filter", query: "snapshot", filters: { collection: "page_secondary" }, relevantIds: snapshotIds.slice(4), requiredIds: snapshotIds.slice(4), excludedIds: snapshotIds.slice(0, 4).concat(ids.unknownDate) },
  { id: "filter-intersection", query: "snapshot", filters: { author: "page_alpha", tag: "page_even", collection: "page_primary" }, relevantIds: [ids.snapshotOne, ids.snapshotThree], requiredIds: [ids.snapshotOne, ids.snapshotThree], excludedIds: [ids.snapshotTwo, ids.snapshotFour, ids.snapshotFive, ids.snapshotSix, ids.unknownDate] },
  { id: "empty-filter-intersection", query: "snapshot", filters: { author: "page_alpha", collection: "page_secondary" }, relevantIds: [], empty: true },
  { id: "date-range", query: "snapshot", filters: { from: "2025-04-01T00:00:00.000Z", to: "2025-04-01T23:59:59.999Z" }, relevantIds: snapshotIds, requiredIds: snapshotIds, excludedIds: [ids.unknownDate] },
  { id: "date-after-range", query: "snapshot", filters: { from: "2025-04-02T00:00:00.000Z" }, relevantIds: [], empty: true },
  { id: "date-before-range", query: "snapshot", filters: { to: "2025-03-31T23:59:59.999Z" }, relevantIds: [], empty: true },
  { id: "exact-respects-filter", query: "9007199254740993001", filters: { author: "page_alpha" }, relevantIds: [], empty: true },
  { id: "literal-respects-filter", query: "compilers", filters: { collection: "reading" }, relevantIds: [], empty: true },
  { id: "fuzzy-respects-filter", query: "compilres", filters: { tag: "annotation" }, relevantIds: [], empty: true },
  { id: "cursor-tied-results", query: "pagination", relevantIds: snapshotIds, requiredIds: snapshotIds, pagination: { limit: 2, expectedIds: snapshotIds } },
  { id: "cursor-retains-filter", query: "pagination", filters: { author: "page_alpha" }, relevantIds: snapshotIds.slice(0, 3), requiredIds: snapshotIds.slice(0, 3), excludedIds: snapshotIds.slice(3), pagination: { limit: 1, expectedIds: snapshotIds.slice(0, 3) } },
  { id: "cursor-filter-intersection", query: "pagination", filters: { tag: "page_even", collection: "page_primary" }, relevantIds: [ids.snapshotOne, ids.snapshotThree], requiredIds: [ids.snapshotOne, ids.snapshotThree], pagination: { limit: 1, expectedIds: [ids.snapshotOne, ids.snapshotThree] } },
  { id: "null-text-no-invented-content", query: "searchabletextinvented7291", relevantIds: [], empty: true },
  { id: "non-english-literal", query: "multilingue", relevantIds: [ids.multilingual], firstId: ids.multilingual },
];
