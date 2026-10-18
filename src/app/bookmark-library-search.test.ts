import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  instances: 0,
  initialize: vi.fn<() => Promise<"webgpu" | "wasm">>(),
  embedQuery: vi.fn<(query: string) => Promise<number[]>>(),
  dispose: vi.fn(),
}));

vi.mock("@/lib/embeddings/indexing-client", () => ({
  EmbeddingIndexer: class {},
  initialEmbeddingIndexingState: () => ({
    phase: "idle", completed: 0, failed: 0, superseded: 0, error: null, counts: null, statusError: null,
    model: { phase: "idle", backend: null, downloadPercent: null, fallback: false },
  }),
  LocalEmbeddingClient: class {
    constructor() { client.instances += 1; }
    initialize = client.initialize;
    embedQuery = client.embedQuery;
    dispose = client.dispose;
  },
}));

import { LibrarySearchSession, type LibrarySearchInput } from "./bookmark-library";
import { EMBEDDING_CONTRACT } from "@/lib/embeddings/contracts";

const vector = [1, ...Array<number>(383).fill(0)];
const page = (ids: string[], nextCursor: string | null = null) => ({
  bookmarks: ids.map((id) => ({ id, matchKind: "semantic", tags: [], collections: [] })), nextCursor,
});
const input = (overrides: Partial<LibrarySearchInput> = {}): LibrarySearchInput => ({
  q: "synthetic concept", mode: "hybrid", consent: true, sort: "relevance", author: "", from: "", to: "",
  media: "any", tag: "", collection: "", cursor: null, ...overrides,
});

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  client.instances = 0;
  client.initialize.mockReset().mockResolvedValue("webgpu");
  client.embedQuery.mockReset().mockResolvedValue(vector);
  client.dispose.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("library search mode controller", () => {
  it("uses the existing lexical GET for Exact or missing local consent without creating a worker", async () => {
    const fetcher = installFetch(() => json(page(["lexical"]))) as ReturnType<typeof vi.fn>;
    const session = new LibrarySearchSession();
    const exact = await session.search(input({ mode: "exact" }));
    const noConsent = await session.search(input({ consent: false }));
    expect(exact).toMatchObject({ mode: "exact", semanticFailed: false, page: { bookmarks: [{ id: "lexical" }] } });
    expect(noConsent.mode).toBe("exact");
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/bookmarks?"))).toBe(true);
    expect(client.instances).toBe(0);
    session.dispose();
  });

  it("uses one local query vector for All cursor pages and keeps the existing POST contract", async () => {
    let semanticRequests = 0;
    const fetcher = installFetch((url, init) => {
      if (url.startsWith("/api/bookmarks/search")) {
        semanticRequests += 1;
        const body = JSON.parse(String(init?.body)) as { mode: string; queryVector: number[]; cursor?: string; contract: typeof EMBEDDING_CONTRACT };
        expect(body.mode).toBe("hybrid");
        expect(body.queryVector).toEqual(vector);
        expect(body.contract).toEqual(EMBEDDING_CONTRACT);
        expect(body.cursor).toBe(semanticRequests === 1 ? undefined : "next-semantic");
        return json(page([`semantic-${semanticRequests}`], semanticRequests === 1 ? "next-semantic" : null));
      }
      return json(page(["exact-preview"]));
    });
    const session = new LibrarySearchSession();
    const first = await session.search(input());
    const second = await session.search(input({ cursor: first.page.nextCursor }));
    expect(first.mode).toBe("hybrid");
    expect(second.page.bookmarks[0].id).toBe("semantic-2");
    expect(semanticRequests).toBe(2);
    expect(client.instances).toBe(1);
    expect(client.initialize).toHaveBeenCalledOnce();
    expect(client.embedQuery).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/bookmarks/search", expect.objectContaining({ method: "POST" }));
    session.dispose();
  });

  it("uses Meaning mode and falls back to Exact after a private semantic failure", async () => {
    installFetch((url) => url.startsWith("/api/bookmarks/search")
      ? json({ error: "library_unavailable" }, 503) : json(page(["exact-result"])));
    const session = new LibrarySearchSession();
    const result = await session.search(input({ mode: "meaning", cursor: "stale-semantic-cursor" }));
    expect(result).toMatchObject({
      mode: "exact", semanticFailed: true, page: { bookmarks: [{ id: "exact-result" }], nextCursor: null },
    });
    expect(client.embedQuery).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("distinguishes a changed embedding contract from a model loading failure", async () => {
    installFetch((url) => url.startsWith("/api/bookmarks/search")
      ? json({ error: "embedding_contract_mismatch" }, 422) : json(page(["exact-result"])));
    const result = await new LibrarySearchSession().search(input({ mode: "meaning" }));
    expect(result).toMatchObject({ mode: "exact", semanticFailed: true, semanticFailureReason: "contract_mismatch" });
  });

  it("restarts Meaning in the same mode when a stale semantic cursor is rejected", async () => {
    let semanticRequests = 0;
    const fetcher = installFetch((url, init) => {
      if (!url.startsWith("/api/bookmarks/search")) return json(page(["exact-preview"]));
      semanticRequests += 1;
      const body = JSON.parse(String(init?.body)) as { cursor?: string; mode: string };
      if (semanticRequests === 1) {
        expect(body.cursor).toBe("stale-cursor");
        return json({ error: "invalid_cursor" }, 422);
      }
      expect(body.cursor).toBeUndefined();
      expect(body.mode).toBe("meaning");
      return json(page(["meaning-first-page"], "fresh-cursor"));
    });
    const session = new LibrarySearchSession();
    const result = await session.search(input({ mode: "meaning", cursor: "stale-cursor" }));
    expect(result).toMatchObject({
      mode: "meaning", semanticFailed: false, semanticRestarted: true,
      page: { bookmarks: [{ id: "meaning-first-page" }], nextCursor: "fresh-cursor" },
    });
    expect(semanticRequests).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    session.dispose();
  });

  it("allows a same-query retry when local model initialization fails once", async () => {
    client.initialize.mockRejectedValueOnce(new Error("private synthetic failure")).mockResolvedValueOnce("wasm");
    installFetch((url) => url.startsWith("/api/bookmarks/search") ? json(page(["semantic-result"])) : json(page(["exact-result"])));
    const session = new LibrarySearchSession();
    const first = await session.search(input());
    expect(first.semanticFailed).toBe(true);
    const second = await session.search(input());
    expect(second.mode).toBe("hybrid");
    expect(second.page.bookmarks[0].id).toBe("semantic-result");
    expect(client.initialize).toHaveBeenCalledTimes(2);
    expect(client.embedQuery).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("invalidates an in-flight query when filters change and ignores its late model result", async () => {
    let releaseInitialization!: (backend: "webgpu" | "wasm") => void;
    client.initialize.mockImplementationOnce(() => new Promise((resolve) => { releaseInitialization = resolve; }));
    const fetcher = installFetch(() => json(page(["filtered-exact-result"]))) as ReturnType<typeof vi.fn>;
    const session = new LibrarySearchSession();
    const obsolete = session.search(input());
    expect(client.initialize).toHaveBeenCalledOnce();
    const current = await session.search(input({ mode: "exact", author: "new-owner" }));
    releaseInitialization("webgpu");
    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    expect(current.page.bookmarks[0].id).toBe("filtered-exact-result");
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith("/api/bookmarks/search"))).toBe(false);
    expect(client.dispose).toHaveBeenCalledOnce();
    session.dispose();
  });
});
