import { z } from "zod";
import { EMBEDDING_CONTRACT, validateEmbeddingVector, type EmbeddingDocumentInput } from "./contracts";
import type { EmbeddingBackend, EmbeddingErrorCode, EmbeddingModelStatus, EmbeddingWorkerRequest, EmbeddingWorkerResponse } from "./worker";

export type { EmbeddingBackend, EmbeddingModelStatus } from "./worker";

const messages: Record<EmbeddingErrorCode, string> = {
  model_unavailable: "The local model is unavailable. Check your connection and browser storage, then retry.",
  model_load_failed: "The local model could not load. Check your connection and browser storage, then retry.",
  embedding_failed: "Local embedding generation failed. Finished work is saved; you can retry.",
  unsupported_runtime: "This browser cannot run the local model. Try a browser with Web Worker and WebAssembly support.",
  indexing_cancelled: "Local indexing was stopped. Finished work is saved.",
};

export class LocalEmbeddingError extends Error {
  constructor(readonly code: EmbeddingErrorCode) { super(messages[code]); }
}

type PendingRequest = {
  resolve: (result: Extract<EmbeddingWorkerResponse, { type: "result" }>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** No worker or model asset download is started by constructing this client. */
export class LocalEmbeddingClient {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();

  constructor(private readonly onStatus: (status: EmbeddingModelStatus) => void = () => undefined) {}

  private stop(error: LocalEmbeddingError) {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private getWorker(): Worker {
    if (!this.worker) {
      if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
        throw new LocalEmbeddingError("unsupported_runtime");
      }
      try {
        this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      } catch {
        throw new LocalEmbeddingError("unsupported_runtime");
      }
      this.worker.addEventListener("message", (event: MessageEvent<EmbeddingWorkerResponse>) => {
        const result = event.data;
        if (result.type === "status") {
          this.onStatus(result.status);
          return;
        }
        const entry = this.pending.get(result.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(result.id);
        if (result.type === "error") entry.reject(new LocalEmbeddingError(result.errorCode));
        else entry.resolve(result);
      });
      const failed = () => this.stop(new LocalEmbeddingError("model_unavailable"));
      this.worker.addEventListener("error", (event) => { event.preventDefault(); failed(); });
      this.worker.addEventListener("messageerror", failed);
    }
    return this.worker;
  }

  private request(request: EmbeddingWorkerRequest): Promise<Extract<EmbeddingWorkerResponse, { type: "result" }>> {
    return new Promise((resolve, reject) => {
      const worker = this.getWorker();
      const timer = setTimeout(() => {
        this.stop(new LocalEmbeddingError(request.type === "initialize" ? "model_load_failed" : "embedding_failed"));
      }, request.type === "initialize" ? 600_000 : 90_000);
      this.pending.set(request.id, { resolve, reject, timer });
      try {
        worker.postMessage(request);
      } catch {
        this.stop(new LocalEmbeddingError("embedding_failed"));
      }
    });
  }

  async initialize(): Promise<EmbeddingBackend> {
    return (await this.request({ type: "initialize", id: ++this.sequence })).backend;
  }

  async embedDocument(document: EmbeddingDocumentInput, contentHash: string): Promise<number[]> {
    const result = await this.request({ type: "document", id: ++this.sequence, document, contentHash });
    return validateEmbeddingVector(result.vector);
  }

  async embedQuery(query: string): Promise<number[]> {
    const result = await this.request({ type: "query", id: ++this.sequence, query });
    return validateEmbeddingVector(result.vector);
  }

  dispose() { this.stop(new LocalEmbeddingError("indexing_cancelled")); }
}

const claimSchema = z.object({
  bookmarkId: z.string().min(1).max(128),
  document: z.object({
    text: z.string().nullable().optional(),
    quotedText: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
  }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  claimToken: z.string().min(1).max(256),
  leaseExpiresAt: z.string().datetime(),
});
const claimsSchema = z.object({ claims: z.array(claimSchema).max(1), contract: z.record(z.string(), z.unknown()) });
const completionSchema = z.object({ completed: z.literal(true), alreadyCompleted: z.boolean() });
const statusSchema = z.object({
  total: z.number().int().nonnegative(), ready: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(), processing: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
});
const retrySchema = z.object({ retried: z.number().int().min(0).max(10) });
type Claim = z.infer<typeof claimSchema>;
export type EmbeddingIndexStatus = z.infer<typeof statusSchema>;

export type EmbeddingIndexingState = {
  phase: "idle" | "retrying" | "starting" | "running" | "pausing" | "paused" | "complete" | "error";
  completed: number;
  failed: number;
  superseded: number;
  error: string | null;
  counts: EmbeddingIndexStatus | null;
  statusError: string | null;
  model: EmbeddingModelStatus;
};

export function initialEmbeddingIndexingState(): EmbeddingIndexingState {
  return { phase: "idle", completed: 0, failed: 0, superseded: 0, error: null, counts: null, statusError: null,
    model: { phase: "idle", backend: null, downloadPercent: null, fallback: false } };
}

class IndexingRequestError extends Error {
  constructor(readonly status: number) { super("The indexing request failed. Finished work is saved; retry when your connection is available."); }
}

/** Server leases make completed work resumable across tabs and browser restarts. */
export class EmbeddingIndexer {
  private state = initialEmbeddingIndexingState();
  private paused = false;
  private disposed = false;
  private running: Promise<void> | null = null;
  private retrying = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private statusSequence = 0;
  private currentClaim: Claim | null = null;
  private readonly controller = new AbortController();
  private readonly embeddings: LocalEmbeddingClient;

  constructor(private readonly onChange: (state: EmbeddingIndexingState) => void) {
    this.embeddings = new LocalEmbeddingClient((model) => this.update({ model }));
  }

  private update(patch: Partial<EmbeddingIndexingState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.onChange({ ...this.state, model: { ...this.state.model } });
  }

  private async post(path: "claim" | "complete" | "fail" | "retry", body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`/api/embeddings/${path}`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: this.controller.signal,
      });
    } catch {
      throw new IndexingRequestError(0);
    }
    if (!response.ok) throw new IndexingRequestError(response.status);
    try { return await response.json(); } catch { throw new IndexingRequestError(response.status); }
  }

  private async complete(claim: Claim, vector: number[]) {
    const body = { bookmarkId: claim.bookmarkId, claimToken: claim.claimToken, contentHash: claim.contentHash, vector };
    try {
      return completionSchema.parse(await this.post("complete", body));
    } catch (error) {
      // One bounded retry is safe even when the first response was lost after commit.
      if (!(error instanceof IndexingRequestError) || (error.status !== 0 && error.status < 500)) throw error;
      return completionSchema.parse(await this.post("complete", body));
    }
  }

  private async fail(claim: Claim, errorCode: EmbeddingErrorCode) {
    try { await this.post("fail", { bookmarkId: claim.bookmarkId, claimToken: claim.claimToken, errorCode }); }
    catch { /* An interrupted or replaced claim becomes available again after its lease expires. */ }
    await this.refreshStatus();
  }

  /** Safe to call on page load: this reads counts without starting the model. */
  async refreshStatus(): Promise<EmbeddingIndexStatus | null> {
    if (this.disposed) return null;
    const sequence = ++this.statusSequence;
    try {
      const response = await fetch("/api/embeddings/status", {
        credentials: "same-origin", cache: "no-store", signal: this.controller.signal,
      });
      if (!response.ok) throw new IndexingRequestError(response.status);
      const counts = statusSchema.parse(await response.json());
      if (sequence === this.statusSequence) this.update({ counts, statusError: null });
      return counts;
    } catch {
      if (sequence === this.statusSequence) this.update({ statusError: "Index counts could not be refreshed. Displayed counts may be out of date." });
      return null;
    }
  }

  /** An explicit owner action resets only a small number of exhausted failures. */
  async retryFailed(limit = 10): Promise<void> {
    if (this.disposed || this.running || this.retrying) return;
    z.number().int().min(1).max(10).parse(limit);
    this.retrying = true;
    this.update({ phase: "retrying", error: null });
    try {
      const result = retrySchema.parse(await this.post("retry", { limit }));
      await this.refreshStatus();
      this.retrying = false;
      if (this.disposed) return;
      if (result.retried === 0) this.update({ phase: "complete" });
      else await this.start();
    } catch {
      this.update({ phase: "error", error: "Failed bookmarks could not be retried. Refresh index counts and try again." });
    } finally {
      this.retrying = false;
    }
  }

  start(): Promise<void> {
    if (this.disposed || this.retrying) return Promise.resolve();
    if (this.running) return this.running;
    this.paused = false;
    this.update({ phase: "starting", error: null });
    this.poll = setInterval(() => { void this.refreshStatus(); }, 5_000);
    this.running = this.run().finally(() => {
      if (this.poll) clearInterval(this.poll);
      this.poll = null;
      this.running = null;
    });
    return this.running;
  }

  pause() {
    if (!this.running || this.disposed) return;
    this.paused = true;
    this.update({ phase: "pausing" });
  }

  private async run() {
    try {
      const counts = await this.refreshStatus();
      if (!counts) {
        this.update({ phase: "error", error: "Index counts are unavailable. Refresh them before starting local indexing. Keyword search remains available." });
        return;
      }
      if (this.paused || this.disposed) { this.update({ phase: "paused" }); return; }
      if (counts.pending + counts.stale === 0) { this.update({ phase: "complete" }); return; }
      // Download before taking a short lease, so slow first loads cannot expire it.
      await this.embeddings.initialize();
      while (!this.paused && !this.disposed) {
        this.update({ phase: "running" });
        const data = claimsSchema.parse(await this.post("claim", { limit: 1 }));
        this.currentClaim = data.claims[0] ?? null;
        await this.refreshStatus();
        if (!Object.entries(EMBEDDING_CONTRACT).every(([key, value]) => data.contract[key] === value)) {
          throw new Error("The embedding model contract changed. Reload this page before indexing again.");
        }
        const claim = this.currentClaim;
        if (!claim) {
          this.update({ phase: this.paused ? "paused" : "complete" });
          return;
        }
        if (this.paused || this.disposed) {
          await this.fail(claim, "indexing_cancelled");
          this.currentClaim = null;
          break;
        }
        const vector = await this.embeddings.embedDocument(claim.document, claim.contentHash);
        try {
          await this.complete(claim, vector);
          this.update({ completed: this.state.completed + 1 });
        } catch (error) {
          if (!(error instanceof IndexingRequestError) || (error.status !== 404 && error.status !== 409)) throw error;
          this.update({ superseded: this.state.superseded + 1 });
        }
        this.currentClaim = null;
        await this.refreshStatus();
      }
      this.update({ phase: "paused" });
    } catch (error) {
      const claim = this.currentClaim;
      this.currentClaim = null;
      if (claim && !this.disposed) {
        await this.fail(claim, error instanceof LocalEmbeddingError ? error.code : "embedding_failed");
        this.update({ failed: this.state.failed + 1 });
      }
      if (this.disposed) return;
      const message = error instanceof LocalEmbeddingError || error instanceof IndexingRequestError
        ? error.message
        : "Indexing could not continue. Reload this page and retry. Finished work is saved.";
      this.update({ phase: "error", error: message, model: error instanceof LocalEmbeddingError
        ? { ...this.state.model, phase: "error", downloadPercent: null } : this.state.model });
    }
  }

  dispose() {
    this.disposed = true;
    this.paused = true;
    this.controller.abort();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.embeddings.dispose();
    const claim = this.currentClaim;
    this.currentClaim = null;
    if (claim) {
      // Best effort on unmount; correctness also holds if the browser drops this request.
      void fetch("/api/embeddings/fail", {
        method: "POST", credentials: "same-origin", cache: "no-store", keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkId: claim.bookmarkId, claimToken: claim.claimToken, errorCode: "indexing_cancelled" }),
      }).catch(() => undefined);
    }
  }
}
