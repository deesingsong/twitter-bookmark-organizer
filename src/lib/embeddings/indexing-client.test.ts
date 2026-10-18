import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_CONTRACT } from "./contracts";
import { EmbeddingIndexer, LocalEmbeddingClient, type EmbeddingIndexingState } from "./indexing-client";
import type { EmbeddingWorkerRequest, EmbeddingWorkerResponse } from "./worker";

const vector = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
const claim = {
  bookmarkId: "00000000-0000-4000-8000-000000000001",
  document: { text: "Synthetic passage.", quotedText: null, note: null, tags: [] },
  contentHash: "a".repeat(64), claimToken: "00000000-0000-4000-8000-000000000002",
  leaseExpiresAt: "2026-10-17T12:03:00.000Z",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const claimResponse = (claims: typeof claim[]) => json({ claims, contract: EMBEDDING_CONTRACT });
const counts = { total: 4, ready: 1, pending: 1, processing: 0, stale: 1, failed: 1 };
function installFetch(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => url.endsWith("status")
    ? Promise.resolve(json(counts)) : fetcher(url, init));
}

let handleRequest: (worker: FakeWorker, request: EmbeddingWorkerRequest) => void;
class FakeWorker {
  static instances: FakeWorker[] = [];
  private listeners: Record<string, ((event: { data: EmbeddingWorkerResponse }) => void)[]> = {};
  terminate = vi.fn();
  postMessage = vi.fn((request: EmbeddingWorkerRequest) => { handleRequest(this, request); });
  constructor() { FakeWorker.instances.push(this); }
  addEventListener(type: string, listener: (event: { data: EmbeddingWorkerResponse }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(data: EmbeddingWorkerResponse) { for (const listener of this.listeners.message ?? []) listener({ data }); }
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  handleRequest = (worker, request) => queueMicrotask(() => worker.emit({
    type: "result", id: request.id, backend: "wasm", vector: request.type === "initialize" ? null : vector,
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("local embedding client", () => {
  it("creates no worker until used and reuses it for prefixed query inference", async () => {
    const client = new LocalEmbeddingClient();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(await client.initialize()).toBe("wasm");
    expect(await client.embedQuery("synthetic query")).toEqual(vector);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].postMessage).toHaveBeenLastCalledWith({ type: "query", id: 2, query: "synthetic query" });
    client.dispose();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("rejects unsupported browsers without creating a worker", async () => {
    vi.stubGlobal("Worker", undefined);
    const client = new LocalEmbeddingClient();
    await expect(client.initialize()).rejects.toMatchObject({ code: "unsupported_runtime" });
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe("resumable browser indexing", () => {
  it("loads persistent status without creating a worker or claiming work", async () => {
    const fetcher = vi.fn(async () => json(counts));
    vi.stubGlobal("fetch", fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.refreshStatus();
    expect(states.at(-1)).toMatchObject({ phase: "idle", counts, statusError: null });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/embeddings/status", expect.objectContaining({ cache: "no-store" }));
    indexer.dispose();
  });

  it("does not load the model for an already indexed library", async () => {
    const fetcher = vi.fn(async () => json({ total: 4, ready: 4, pending: 0, processing: 0, stale: 0, failed: 0 }));
    vi.stubGlobal("fetch", fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.start();
    expect(states.at(-1)).toMatchObject({ phase: "complete", completed: 0 });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/embeddings/status", expect.anything());
    indexer.dispose();
  });

  it("fails closed without loading the model when current counts cannot be read", async () => {
    const fetcher = vi.fn(async () => json({ error: "SYNTHETIC_PRIVATE_CONTENT" }, 503));
    vi.stubGlobal("fetch", fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.start();
    expect(states.at(-1)).toMatchObject({ phase: "error", counts: null });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(JSON.stringify(states)).not.toContain("SYNTHETIC_PRIVATE_CONTENT");
    indexer.dispose();
  });

  it("claims one item, embeds its exact document and completes without sending text back", async () => {
    let claimed = false;
    const fetcher = vi.fn(async (url: string) => url.endsWith("claim")
      ? claimResponse(claimed ? [] : (claimed = true, [claim]))
      : json({ completed: true, alreadyCompleted: false }));
    installFetch(fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.start();
    expect(states.at(-1)).toMatchObject({ phase: "complete", completed: 1, failed: 0, superseded: 0 });
    expect(FakeWorker.instances[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "document", document: claim.document, contentHash: claim.contentHash,
    }));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/embeddings/claim", "/api/embeddings/complete", "/api/embeddings/claim"]);
    const requests = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(requests[0][1].body as string)).toEqual({ limit: 1 });
    expect(JSON.parse(requests[1][1].body as string)).toEqual({ bookmarkId: claim.bookmarkId, claimToken: claim.claimToken, contentHash: claim.contentHash, vector });
    expect(requests[1][1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    indexer.dispose();
  });

  it("finishes the in-flight bookmark before pausing and resumes from server claims", async () => {
    let documentRequest: EmbeddingWorkerRequest | null = null;
    const automatic = handleRequest;
    handleRequest = (worker, request) => {
      if (request.type === "document") documentRequest = request;
      else automatic(worker, request);
    };
    let claimCalls = 0;
    const fetcher = vi.fn(async (url: string) => url.endsWith("claim")
      ? claimResponse(++claimCalls === 1 ? [claim] : []) : json({ completed: true, alreadyCompleted: false }));
    installFetch(fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    const run = indexer.start();
    await vi.waitFor(() => expect(documentRequest).not.toBeNull());
    indexer.pause();
    expect(states.at(-1)?.phase).toBe("pausing");
    FakeWorker.instances[0].emit({ type: "result", id: documentRequest!.id, vector, backend: "wasm" });
    await run;
    expect(states.at(-1)).toMatchObject({ phase: "paused", completed: 1 });
    expect(claimCalls).toBe(1);
    await indexer.start();
    expect(states.at(-1)).toMatchObject({ phase: "complete", completed: 1 });
    expect(claimCalls).toBe(2);
    expect(FakeWorker.instances).toHaveLength(1);
    indexer.dispose();
  });

  it.each([404, 409])("counts a %s completion as superseded without recreating or failing it", async (status) => {
    let claimed = false;
    const fetcher = vi.fn(async (url: string) => url.endsWith("claim")
      ? claimResponse(claimed ? [] : (claimed = true, [claim])) : json({ error: "conflict" }, status));
    installFetch(fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.start();
    expect(states.at(-1)).toMatchObject({ phase: "complete", completed: 0, superseded: 1, failed: 0 });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("fail"))).toBe(false);
    indexer.dispose();
  });

  it("retries a lost completion response once with the same payload", async () => {
    let claimed = false;
    let completions = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("claim")) return claimResponse(claimed ? [] : (claimed = true, [claim]));
      if (++completions === 1) throw new Error("Synthetic connection loss");
      return json({ completed: true, alreadyCompleted: true });
    });
    installFetch(fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.start();
    const requests = fetcher.mock.calls as unknown as [string, RequestInit][];
    const completionBodies = requests.filter(([url]) => url.endsWith("complete")).map(([, init]) => init.body);
    expect(completionBodies).toHaveLength(2);
    expect(completionBodies[0]).toBe(completionBodies[1]);
    expect(states.at(-1)).toMatchObject({ phase: "complete", completed: 1 });
    indexer.dispose();
  });

  it("takes no claims when a model download fails", async () => {
    handleRequest = (worker, request) => queueMicrotask(() => worker.emit({ type: "error", id: request.id, errorCode: "model_load_failed" }));
    const fetcher = vi.fn();
    installFetch(fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.start();
    expect(states.at(-1)).toMatchObject({ phase: "error", failed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    indexer.dispose();
  });

  it("reports only a fixed failure code and stops after inference fails", async () => {
    const automatic = handleRequest;
    handleRequest = (worker, request) => request.type === "document"
      ? queueMicrotask(() => worker.emit({ type: "error", id: request.id, errorCode: "embedding_failed" })) : automatic(worker, request);
    const fetcher = vi.fn(async (url: string) => url.endsWith("claim") ? claimResponse([claim]) : json({ failed: true }));
    installFetch(fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.start();
    expect(states.at(-1)).toMatchObject({ phase: "error", failed: 1, completed: 0 });
    const requests = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(requests[1][1].body as string)).toEqual({ bookmarkId: claim.bookmarkId, claimToken: claim.claimToken, errorCode: "embedding_failed" });
    expect(JSON.stringify(states)).not.toContain(claim.document.text);
    indexer.dispose();
  });

  it("does not expose API error bodies", async () => {
    installFetch(vi.fn(async () => json({ error: "SYNTHETIC_PRIVATE_CONTENT" }, 500)));
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.start();
    expect(states.at(-1)?.phase).toBe("error");
    expect(JSON.stringify(states)).not.toContain("SYNTHETIC_PRIVATE_CONTENT");
    indexer.dispose();
  });

  it("retries a bounded set of failed rows only after an explicit action", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("retry")
      ? json({ retried: 1 }) : claimResponse([]));
    installFetch(fetcher);
    const states: EmbeddingIndexingState[] = [];
    const indexer = new EmbeddingIndexer(state => states.push(state));
    await indexer.refreshStatus();
    expect(fetcher).not.toHaveBeenCalled();
    await indexer.retryFailed(1);
    const requests = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(requests[0][0]).toBe("/api/embeddings/retry");
    expect(JSON.parse(requests[0][1].body as string)).toEqual({ limit: 1 });
    expect(states.some(state => state.phase === "retrying")).toBe(true);
    expect(states.at(-1)?.phase).toBe("complete");
    indexer.dispose();
  });
});
