export const MAX_SEARCH_QUERY_LENGTH = 300;

export type ParsedSearchQuery = {
  /** NFC-normalized input with outer whitespace removed; literal punctuation is retained. */
  normalized: string;
  tweetIds: string[];
  canonicalUrls: string[];
  /** Handles and hashtags omit their prefix and use lowercase. */
  handles: string[];
  hashtags: string[];
  phrases: string[];
  literals: string[];
  terms: string[];
  /** Only ordinary word queries of at least four letters permit typo fallback. */
  fuzzyText: string | null;
};

type QueryToken = { kind: "word" | "phrase" | "literal"; value: string };

const PLAIN_WORD = /^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*$/u;
const HANDLE = /^@([a-z\d_]{1,64})$/i;
const HASHTAG = /^#([\p{L}\p{M}\p{N}_]+)$/u;
const TWEET_ID = /^\d{1,30}$/;
const STATUS_HOSTS = new Set(["x.com", "mobile.x.com", "twitter.com", "mobile.twitter.com"]);

function statusTweetId(value: string): string | null {
  const candidate = /^(?:www\.)?(?:mobile\.)?(?:x|twitter)\.com\//i.test(value)
    ? `https://${value}`
    : value;

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!STATUS_HOSTS.has(host) || !["https:", "http:"].includes(url.protocol)
      || url.username || url.password) return null;

    return url.pathname.match(/\/status\/(\d{1,30})(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Quotes and backticks group values; no SQL, Boolean, or field-operator grammar is interpreted. */
function tokenize(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let index = 0;

  while (index < query.length) {
    if (/\s/u.test(query[index])) {
      index += 1;
      continue;
    }

    const opening = query[index];
    const closing = opening === "“" ? "”" : opening;
    if (opening === '"' || opening === "“" || opening === "`") {
      const start = index;
      let value = "";
      let closed = false;
      index += 1;

      while (index < query.length) {
        const character = query[index];
        if (character === "\\" && (query[index + 1] === closing || query[index + 1] === "\\")) {
          value += query[index + 1];
          index += 2;
        } else if (character === closing) {
          index += 1;
          closed = true;
          break;
        } else {
          value += character;
          index += 1;
        }
      }

      if (!closed) {
        // Keep an unfinished quote as a literal rather than silently broadening the query.
        tokens.push({ kind: "literal", value: query.slice(start) });
      } else if (value.trim()) {
        tokens.push({ kind: opening === "`" ? "literal" : "phrase", value });
      } else {
        // Empty quote syntax must not turn into an unfiltered browse request.
        tokens.push({ kind: "literal", value: query.slice(start, index) });
      }
      continue;
    }

    const start = index;
    while (index < query.length && !/\s/u.test(query[index])) index += 1;
    tokens.push({ kind: "word", value: query.slice(start, index) });
  }

  return tokens;
}

/**
 * Parse bounded search intent into parameter values. Callers must still parameterize SQL;
 * punctuation such as %, _, quotes, and backslashes is deliberately not SQL-escaped here.
 */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  if (input.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new RangeError(`Search query exceeds ${MAX_SEARCH_QUERY_LENGTH} characters`);
  }

  const normalized = input.trim().normalize("NFC");
  const result: ParsedSearchQuery = {
    normalized,
    tweetIds: [],
    canonicalUrls: [],
    handles: [],
    hashtags: [],
    phrases: [],
    literals: [],
    terms: [],
    fuzzyText: null,
  };

  for (const token of tokenize(normalized)) {
    if (token.kind === "phrase") {
      result.phrases.push(token.value);
      continue;
    }
    if (token.kind === "literal") {
      result.literals.push(token.value);
      continue;
    }

    const tweetId = statusTweetId(token.value);
    if (tweetId) {
      result.tweetIds.push(tweetId);
      result.canonicalUrls.push(`https://x.com/i/web/status/${tweetId}`);
      continue;
    }
    if (TWEET_ID.test(token.value)) {
      result.tweetIds.push(token.value);
      continue;
    }

    const handle = token.value.match(HANDLE);
    if (handle) {
      result.handles.push(handle[1].toLowerCase());
      continue;
    }
    const hashtag = token.value.match(HASHTAG);
    if (hashtag) {
      result.hashtags.push(hashtag[1].toLowerCase());
      continue;
    }

    if (PLAIN_WORD.test(token.value)) result.terms.push(token.value);
    else result.literals.push(token.value);
  }

  const exactIntent = result.tweetIds.length + result.canonicalUrls.length + result.handles.length
    + result.hashtags.length + result.phrases.length + result.literals.length > 0;
  const letters = result.terms.join("").match(/\p{L}/gu)?.length ?? 0;
  if (!exactIntent && letters >= 4) result.fuzzyText = result.terms.join(" ").toLowerCase();

  result.tweetIds = [...new Set(result.tweetIds)];
  result.canonicalUrls = [...new Set(result.canonicalUrls)];
  result.handles = [...new Set(result.handles)];
  result.hashtags = [...new Set(result.hashtags)];
  result.phrases = [...new Set(result.phrases)];
  result.literals = [...new Set(result.literals)];
  result.terms = [...new Set(result.terms)];
  return result;
}
