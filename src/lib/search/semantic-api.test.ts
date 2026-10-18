import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withDatabase, type Database } from "@/db";
import { bookmarks } from "@/db/schema";
import { GET } from "@/app/api/bookmarks/route";
import { POST } from "@/app/api/bookmarks/search/route";
import { EMBEDDING_CONTRACT } from "@/lib/embeddings/contracts";
import { MAX_SEMANTIC_SEARCH_BYTES, semanticSearchSchema } from "./semantic-request";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ withDatabase: vi.fn() }));

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const date = "2026-01-01T00:00:00.000Z";
const vector = [1, ...Array<number>(383).fill(0)];
const defaultInput = { q: "conceptual search", mode: "meaning", contract: EMBEDDING_CONTRACT, queryVector: vector };
type Candidate = { id: string; rank?: number; score?: number; at?: string; distance?: number; status?: string };
type ApiResult = { bookmarks: { id: string; matchKind: string; tags: { name: string }[]; collections: { name: string }[] }[]; nextCursor: string | null };

function request(input: unknown = defaultInput, headers: Record<string, string> = {}) {
  return new Request("https://library.test/api/bookmarks/search", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://library.test", ...headers },
    body: JSON.stringify(input),
  });
}

function fixture(options: { priority?: Candidate[]; lexical?: Candidate[]; semantic?: Candidate[]; get?: Candidate[] } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const all = [...(options.priority ?? []), ...(options.lexical ?? []), ...(options.semantic ?? []), ...(options.get ?? [])];
  const rows = new Map(all.map((candidate) => [candidate.id, candidate]));
  const fields = Object.keys(getTableColumns(bookmarks));
  let branch = 0;
  const fullRow = (candidate: Candidate) => {
    const row: Record<string, unknown> = {
      id: candidate.id, tweetId: "9007199254740993", canonicalUrl: "https://x.com/i/web/status/9007199254740993",
      text: "Invented searchable content", firstImportedAt: date, updatedAt: date,
      hasMedia: false, mediaReferences: [], sourceMetadata: {}, searchDocument: "private index",
      searchText: "private index", searchIdentifiers: ["private index"],
    };
    return fields.map((field) => row[field] ?? null);
  };
  const database = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith("select set_config")) return { rows: [] };
    if (sql.includes('from "bookmark_embeddings"')) return { rows: (options.semantic ?? []).map((candidate) => [
      candidate.id, candidate.at ?? date, candidate.distance ?? 0.5, candidate.status ?? "ready",
      EMBEDDING_CONTRACT.modelId, EMBEDDING_CONTRACT.modelRevision, EMBEDDING_CONTRACT.preprocessingVersion, EMBEDDING_CONTRACT.dimensions,
    ]) };
    if (sql.includes('from "bookmark_tags"') && !sql.startsWith('select "id"')) {
      return { rows: all.length ? [[all[0].id, id(900), "Synthetic tag"]] : [] };
    }
    if (sql.includes('from "collection_bookmarks"') && !sql.startsWith('select "id"')) {
      return { rows: all.length ? [[all[0].id, id(901), "Synthetic collection"]] : [] };
    }
    if (sql.startsWith('select "id", "tweet_id"')) {
      if (sql.includes("case when")) return { rows: (options.get ?? []).map((candidate) => [
        ...fullRow(candidate), candidate.at ?? date, candidate.rank ?? 3, candidate.score ?? 0.5,
      ]) };
      return { rows: params.flatMap((value) => typeof value === "string" && rows.has(value) ? [fullRow(rows.get(value)!)] : []) };
    }
    const selected = branch++ === 0 ? options.priority : options.lexical;
    return { rows: (selected ?? []).map((candidate) => [candidate.id, candidate.at ?? date, candidate.rank ?? 3, candidate.score ?? 0.5]) };
  });
  vi.mocked(withDatabase).mockImplementation(async (operation) => operation(database as unknown as Database));
  return queries;
}

beforeEach(() => vi.clearAllMocks());

describe("semantic request boundary", () => {
  it.each([
    { q: "" }, { q: "a".repeat(301) }, { mode: "lexical" }, { limit: "2" }, { limit: 51 },
    { queryVector: [1] }, { queryVector: Array<number>(384).fill(0) }, { queryVector: [2, ...vector.slice(1)] },
    { queryVector: [Number.NaN, ...vector.slice(1)] }, { queryVector: [Infinity, ...vector.slice(1)] },
    { queryVector: ["1", ...vector.slice(1)] }, { modelId: "other-model" }, { media: "maybe" }, { tag: "not-uuid" },
  ])("rejects invalid input without accessing the database: %j", async (change) => {
    const response = await POST(request({ ...defaultInput, ...change }));
    expect(response.status).toBe(422);
    expect(withDatabase).not.toHaveBeenCalled();
  });

  it("rejects a stale but well-formed embedding contract before database access", async () => {
    const response = await POST(request({ ...defaultInput, contract: { ...EMBEDDING_CONTRACT, modelRevision: "old-revision" } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "embedding_contract_mismatch" });
    expect(withDatabase).not.toHaveBeenCalled();
  });

  it("accepts unit-vector rounding and normalizes query text and vector", () => {
    const input = semanticSearchSchema.parse({ ...defaultInput, q: " cafe\u0301 ", queryVector: [1.0005, ...vector.slice(1)] });
    expect(input.q).toBe("café");
    expect(input.queryVector).toEqual(vector);
    expect(semanticSearchSchema.safeParse({ ...defaultInput, queryVector: [Number.NaN, ...vector.slice(1)] }).success).toBe(false);
  });

  it.each([
    [{ origin: "https://other.test" }, 403], [{ origin: "null" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403], [{ "content-type": "text/plain" }, 415],
    [{ "content-length": String(MAX_SEMANTIC_SEARCH_BYTES + 1) }, 413],
  ] as const)("enforces origin/content type/declared body size: %j", async (headers, status) => {
    expect((await POST(request(defaultInput, headers))).status).toBe(status);
    expect(withDatabase).not.toHaveBeenCalled();
  });

  it("bounds streamed bodies without trusting Content-Length and rejects malformed JSON", async () => {
    for (const [body, status] of [[" ".repeat(MAX_SEMANTIC_SEARCH_BYTES + 1), 413], ["{bad-json", 400]] as const) {
      const response = await POST(new Request("https://library.test/api/bookmarks/search", {
        method: "POST", headers: { "content-type": "application/json", origin: "https://library.test" }, body,
      }));
      expect(response.status).toBe(status);
    }
    expect(withDatabase).not.toHaveBeenCalled();
  });
});

describe("semantic/hybrid API rankings and pagination", () => {
  it("keeps exact ID, phrase, and username candidates ahead of semantic results without requiring embeddings", async () => {
    const queries = fixture({
      priority: [{ id: id(3), rank: 5 }, { id: id(4), rank: 4 }, { id: id(5), rank: 2 }],
      semantic: [{ id: id(2), distance: 0.1 }, { id: id(1), distance: 0.1 }, { id: id(6), distance: 0, status: "stale" }],
    });
    const response = await POST(request({ ...defaultInput, q: 'https://twitter.com/a/status/9007199254740993 @owner "exact phrase"' }));
    expect(response.status).toBe(200);
    const body = await response.json() as ApiResult;
    expect(body.bookmarks.map(({ id }) => id)).toEqual([id(3), id(4), id(5), id(1), id(2)]);
    expect(body.bookmarks.map(({ matchKind }) => matchKind)).toEqual(["exact", "literal", "metadata", "semantic", "semantic"]);
    expect(body.bookmarks[0].tags[0].name).toBe("Synthetic tag");
    expect(body.bookmarks[0].collections[0].name).toBe("Synthetic collection");
    expect(JSON.stringify(body)).not.toMatch(/queryVector|cosineDistance|embedding|searchDocument|searchText|searchIdentifiers|private index/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(queries[1].params).toEqual(expect.arrayContaining(["9007199254740993", "owner", "exact phrase"]));
  });

  it("fuses lexical and semantic ranks with k=60 and labels branch matches", async () => {
    fixture({ priority: [{ id: id(9), rank: 5 }], lexical: [{ id: id(2) }, { id: id(1) }], semantic: [{ id: id(4), distance: 0.1 }, { id: id(1), distance: 0.2 }] });
    const body = await (await POST(request({ ...defaultInput, mode: "hybrid" }))).json() as ApiResult;
    expect(body.bookmarks.map(({ id }) => id)).toEqual([id(9), id(1), id(2), id(4)]);
    expect(body.bookmarks.map(({ matchKind }) => matchKind)).toEqual(["exact", "hybrid", "lexical", "semantic"]);
  });

  it("retains lexical retrieval when there are no eligible vectors", async () => {
    fixture({ lexical: [{ id: id(2) }, { id: id(1) }] });
    const body = await (await POST(request({ ...defaultInput, mode: "hybrid" }))).json() as ApiResult;
    expect(body.bookmarks.map(({ id }) => id)).toEqual([id(2), id(1)]);
    expect(body.bookmarks.map(({ matchKind }) => matchKind)).toEqual(["lexical", "lexical"]);
  });

  it("sorts newest across the complete bounded union while preserving exact priority", async () => {
    fixture({
      priority: [{ id: id(900), rank: 5, at: "2020-01-01T00:00:00Z" }],
      lexical: Array.from({ length: 200 }, (_, index) => ({ id: id(index + 1), at: "2025-01-01T00:00:00Z" })),
      semantic: Array.from({ length: 200 }, (_, index) => ({ id: id(index + 201), distance: index / 200, at: "2026-01-01T00:00:00Z" })),
    });
    const body = await (await POST(request({ ...defaultInput, mode: "hybrid", sort: "newest", limit: 3 }))).json() as ApiResult;
    expect(body.bookmarks.map(({ id }) => id)).toEqual([id(900), id(400), id(399)]);
  });

  it("paginates deterministically and rejects cursor reuse across vector/mode/query/filter/sort changes", async () => {
    const options = { semantic: [{ id: id(1), distance: 0.1 }, { id: id(2), distance: 0.2 }, { id: id(3), distance: 0.3 }] };
    const input = { ...defaultInput, limit: 1 };
    fixture(options);
    const first = await (await POST(request(input))).json() as ApiResult;
    fixture(options);
    expect(await (await POST(request(input))).json()).toEqual(first);
    expect(first.nextCursor).toBeTypeOf("string");
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()) as unknown[];
    expect(decoded).toHaveLength(3);
    expect(decoded[1]).toMatch(/^[a-f0-9]{64}$/);
    fixture(options);
    const second = await (await POST(request({ ...input, cursor: first.nextCursor }))).json() as ApiResult;
    expect(second.bookmarks.map(({ id }) => id)).toEqual([id(2)]);
    fixture(options);
    const third = await (await POST(request({ ...input, cursor: second.nextCursor }))).json() as ApiResult;
    expect(third.bookmarks.map(({ id }) => id)).toEqual([id(3)]);
    expect(third.nextCursor).toBeNull();
    for (const change of [
      { mode: "hybrid" }, { q: "other" }, { author: "other" }, { from: "2025-01-01" }, { to: "2026-01-01" },
      { tag: id(800) }, { collection: id(801) }, { media: "no" }, { sort: "newest" }, { limit: 2 },
      { queryVector: [0, 1, ...Array<number>(382).fill(0)] },
    ]) {
      vi.mocked(withDatabase).mockClear();
      const response = await POST(request({ ...input, cursor: first.nextCursor, ...change }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "invalid_cursor" });
      expect(withDatabase).not.toHaveBeenCalled();
    }
  });

  it("applies all structured filters and the pinned ready contract before each top-200 selection", async () => {
    const queries = fixture();
    const response = await POST(request({ ...defaultInput, mode: "hybrid", author: "invented", from: "2025-01-01", to: "2026-01-01", media: "yes", tag: id(800), collection: id(801) }));
    expect(response.status).toBe(200);
    const branches = queries.filter(({ sql }) => sql.startsWith('select "id", coalesce') || sql.includes('from "bookmark_embeddings"'));
    expect(branches).toHaveLength(3);
    for (const branch of branches) {
      const beforeLimit = branch.sql.slice(0, branch.sql.lastIndexOf(" limit "));
      for (const column of ["author_username", "tweet_created_at", "has_media", "tag_id", "collection_id"]) expect(beforeLimit).toContain(column);
      expect(branch.params).toEqual(expect.arrayContaining(["%invented%", id(800), id(801), true, 200]));
    }
    const semantic = branches.find(({ sql }) => sql.includes('from "bookmark_embeddings"'))!;
    expect(semantic.params).toEqual(expect.arrayContaining(["ready", EMBEDDING_CONTRACT.modelId, EMBEDDING_CONTRACT.modelRevision, EMBEDDING_CONTRACT.preprocessingVersion, 384]));
    expect(semantic.sql).toContain('"embedding" is not null');
    expect(semantic.sql).toContain('"indexed_at" is not null');
    expect(semantic.sql).toContain("between 0 and 2");
    expect(semantic.sql).toContain("<=>");
    expect(semantic.sql).not.toContain(EMBEDDING_CONTRACT.modelId);
  });

  it("rejects an anchor removed from the current candidate ranking", async () => {
    fixture({ semantic: [{ id: id(1), distance: 0.1 }, { id: id(2), distance: 0.2 }] });
    const input = { ...defaultInput, limit: 1 };
    const first = await (await POST(request(input))).json() as ApiResult;
    fixture({ semantic: [{ id: id(2), distance: 0.2 }] });
    const response = await POST(request({ ...input, cursor: first.nextCursor }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_cursor" });
  });

  it("returns a private generic error on database failure", async () => {
    vi.mocked(withDatabase).mockRejectedValue(new Error("sensitive database details"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "library_unavailable" });
  });
});

describe("lexical GET compatibility", () => {
  it("preserves GET response tiers, version-2 cursor and query validation without vectors", async () => {
    const queries = fixture({ get: [{ id: id(2), rank: 5, score: 5 }, { id: id(1), rank: 4, score: 4 }] });
    const response = await GET(new Request("https://library.test/api/bookmarks?q=9007199254740993&limit=1"));
    expect(response.status).toBe(200);
    const body = await response.json() as ApiResult;
    expect(body.bookmarks.map(({ id, matchKind }) => [id, matchKind])).toEqual([[id(2), "exact"]]);
    const cursor = JSON.parse(Buffer.from(body.nextCursor!, "base64url").toString()) as unknown[];
    expect(cursor).toEqual([2, expect.stringMatching(/^[a-f0-9]{16}$/), 5, 5, date, id(2)]);
    expect(queries.find(({ sql }) => sql.includes("case when"))!.params.at(-1)).toBe(2);
    expect(queries.every(({ sql }) => !sql.includes("bookmark_embeddings"))).toBe(true);
    expect((await GET(new Request(`https://library.test/api/bookmarks?q=other&cursor=${body.nextCursor}`))).status).toBe(422);
    expect((await GET(new Request("https://library.test/api/bookmarks?limit=51"))).status).toBe(422);
  });
});
