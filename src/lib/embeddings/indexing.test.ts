import { afterEach, describe, expect, it, vi } from "vitest";
import type { bookmarkEmbeddings } from "@/db/schema";
import { withDatabase } from "@/db";
import { POST as claimPost } from "@/app/api/embeddings/claim/route";
import { POST as completePost } from "@/app/api/embeddings/complete/route";
import { POST as failPost } from "@/app/api/embeddings/fail/route";
import { POST as retryPost } from "@/app/api/embeddings/retry/route";
import { GET as statusGet } from "@/app/api/embeddings/status/route";
import { EMBEDDING_CONTRACT, normalizeEmbeddingVector } from "./contracts";
import {
  canClaimEmbedding,
  claimEmbeddingsSchema,
  completeEmbeddingSchema,
  decideEmbeddingCompletion,
  decideEmbeddingFailure,
  failEmbeddingSchema,
} from "./indexing";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ withDatabase: vi.fn() }));

const bookmarkId = "4549fd91-cdc8-491a-8dc6-3306a0f26e7c";
const claimToken = "99b661f0-8a72-43dd-bbb8-060d21b92a26";
const otherToken = "e0f76320-3ec5-4d78-af2e-88ef273bd84e";
const contentHash = "a".repeat(64);
const now = new Date("2026-10-17T10:00:00.000Z");
const future = new Date(now.getTime() + 60_000);
const past = new Date(now.getTime() - 1);
const vector = [0.6, 0.8, ...Array<number>(382).fill(0)];
const input = { bookmarkId, claimToken, contentHash, vector };
type EmbeddingRow = typeof bookmarkEmbeddings.$inferSelect;

function processing(overrides: Partial<EmbeddingRow> = {}): EmbeddingRow {
  return {
    bookmarkId,
    embedding: null,
    modelId: EMBEDDING_CONTRACT.modelId,
    modelRevision: EMBEDDING_CONTRACT.modelRevision,
    dimensions: EMBEDDING_CONTRACT.dimensions,
    preprocessingVersion: EMBEDDING_CONTRACT.preprocessingVersion,
    contentHash,
    indexedAt: null,
    status: "processing",
    claimToken,
    leaseExpiresAt: future,
    attemptCount: 1,
    lastError: null,
    ...overrides,
  };
}

afterEach(() => vi.resetAllMocks());

describe("embedding indexing request validation", () => {
  it.each([1, 10])("accepts a bounded claim limit of %i", (limit) => {
    expect(claimEmbeddingsSchema.parse({ limit })).toEqual({ limit });
  });

  it.each([0, 11, -1, 1.5, "2", null])("rejects an invalid limit %s", (limit) => {
    expect(claimEmbeddingsSchema.safeParse({ limit }).success).toBe(false);
  });

  it("does not accept client-selected model, lease, attempts or content", () => {
    for (const extra of [
      { modelId: "other-model" }, { contentHash }, { attemptCount: 0 },
      { leaseExpiresAt: future.toISOString() }, { text: "synthetic content" },
    ]) expect(claimEmbeddingsSchema.safeParse({ limit: 1, ...extra }).success).toBe(false);
    expect(completeEmbeddingSchema.safeParse({ ...input, modelRevision: "other" }).success).toBe(false);
  });

  it("accepts finite vectors and validates identity and hashes without coercion", () => {
    expect(completeEmbeddingSchema.parse(input)).toEqual(input);
    for (const extra of [
      { bookmarkId: "not-a-uuid" }, { claimToken: "not-a-uuid" },
      { contentHash: "A".repeat(64) }, { contentHash: "a".repeat(63) },
    ]) expect(completeEmbeddingSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });

  it.each([
    [], Array<number>(383).fill(1), Array<number>(385).fill(1), Array<number>(384).fill(0),
    [Number.NaN, ...vector.slice(1)], [Number.POSITIVE_INFINITY, ...vector.slice(1)],
    ["1", ...vector.slice(1)], [null, ...vector.slice(1)],
  ].map((invalidVector) => ({ invalidVector })))("rejects invalid vector shape, values or norm", ({ invalidVector }) => {
    expect(completeEmbeddingSchema.safeParse({ ...input, vector: invalidVector }).success).toBe(false);
  });

  it("stores only the supported failure codes", () => {
    expect(failEmbeddingSchema.parse({ bookmarkId, claimToken, errorCode: "embedding_failed" }).errorCode)
      .toBe("embedding_failed");
    expect(failEmbeddingSchema.safeParse({ bookmarkId, claimToken, errorCode: "private exception text" }).success)
      .toBe(false);
    expect(failEmbeddingSchema.safeParse({ bookmarkId, claimToken, errorCode: "embedding_failed", message: "private text" }).success)
      .toBe(false);
  });
});

describe("embedding claim lifecycle", () => {
  it("claims missing, pending, stale and expired processing work", () => {
    expect(canClaimEmbedding(null, now)).toBe(true);
    for (const status of ["pending", "stale"]) {
      expect(canClaimEmbedding(processing({ status, leaseExpiresAt: null }), now)).toBe(true);
    }
    expect(canClaimEmbedding(processing({ leaseExpiresAt: past }), now)).toBe(true);
    expect(canClaimEmbedding(processing({ leaseExpiresAt: now }), now)).toBe(true);
  });

  it("does not claim a live lease, exhausted attempts, ready or failed work", () => {
    expect(canClaimEmbedding(processing(), now)).toBe(false);
    expect(canClaimEmbedding(processing({ leaseExpiresAt: null }), now)).toBe(false);
    for (const status of ["pending", "stale", "processing", "ready", "failed"]) {
      expect(canClaimEmbedding(processing({ status, attemptCount: 3, leaseExpiresAt: past }), now)).toBe(false);
    }
    for (const status of ["ready", "failed"]) {
      expect(canClaimEmbedding(processing({ status, leaseExpiresAt: past }), now)).toBe(false);
    }
  });
});

describe("completion guards", () => {
  it("requires a live token for the current enriched content and BGE contract", () => {
    expect(decideEmbeddingCompletion(processing(), input, contentHash, now)).toBe("complete");
    expect(decideEmbeddingCompletion(processing(), input, "b".repeat(64), now)).toBe("conflict");
    expect(decideEmbeddingCompletion(processing({ contentHash: "b".repeat(64) }), input, contentHash, now))
      .toBe("conflict");
  });

  it.each([
    { claimToken: otherToken }, { claimToken: null }, { leaseExpiresAt: now },
    { leaseExpiresAt: past }, { leaseExpiresAt: null }, { status: "pending" },
    { status: "stale" }, { status: "failed" }, { modelId: "old-model" },
    { modelRevision: "old-revision" }, { dimensions: 768 }, { preprocessingVersion: "old-layout" },
  ])("rejects changed, late or incompatible completions: %o", (changes) => {
    expect(decideEmbeddingCompletion(processing(changes), input, contentHash, now)).toBe("conflict");
  });

  it("cannot recreate a missing embedding or a deleted bookmark", () => {
    expect(decideEmbeddingCompletion(null, input, contentHash, now)).toBe("not_found");
  });

  it("acknowledges a float32-equivalent ready value without requiring the cleared token", () => {
    const ready = processing({
      status: "ready", embedding: vector.map(Math.fround), indexedAt: now,
      claimToken: null, leaseExpiresAt: null,
    });
    expect(decideEmbeddingCompletion(ready, input, contentHash, now)).toBe("already_completed");
    const changedVector = normalizeEmbeddingVector([1, ...Array<number>(383).fill(0)]);
    expect(decideEmbeddingCompletion(ready, { ...input, vector: changedVector }, contentHash, now)).toBe("conflict");
    expect(decideEmbeddingCompletion(ready, input, "b".repeat(64), now)).toBe("conflict");
    expect(decideEmbeddingCompletion({ ...ready, indexedAt: null }, input, contentHash, now)).toBe("conflict");
  });
});

describe("failure guards", () => {
  it("retries until the third claimed attempt, then stops", () => {
    expect(decideEmbeddingFailure(processing({ attemptCount: 1 }), claimToken, now)).toBe("pending");
    expect(decideEmbeddingFailure(processing({ attemptCount: 2 }), claimToken, now)).toBe("pending");
    expect(decideEmbeddingFailure(processing({ attemptCount: 3 }), claimToken, now)).toBe("failed");
  });

  it("rejects late failures and old tokens instead of changing replacement work", () => {
    expect(decideEmbeddingFailure(null, claimToken, now)).toBe("not_found");
    expect(decideEmbeddingFailure(processing(), otherToken, now)).toBe("conflict");
    for (const changes of [{ leaseExpiresAt: now }, { leaseExpiresAt: null }, { status: "ready" }]) {
      expect(decideEmbeddingFailure(processing(changes), claimToken, now)).toBe("conflict");
    }
  });
});

function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://library.example.test/api/embeddings/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://library.example.test", ...headers },
    body: JSON.stringify(body),
  });
}

describe("embedding route boundaries", () => {
  const cases = [
    { path: "claim", handler: claimPost, body: { limit: 1 } },
    { path: "complete", handler: completePost, body: input },
    { path: "fail", handler: failPost, body: { bookmarkId, claimToken, errorCode: "embedding_failed" } },
    { path: "retry", handler: retryPost, body: { limit: 1 } },
  ];

  it.each(cases)("requires JSON and same-origin requests for $path before database access", async ({ path, handler, body }) => {
    const crossOrigin = await handler(request(path, body, { Origin: "https://attacker.example" }));
    expect(crossOrigin.status).toBe(403);
    const wrongType = await handler(request(path, body, { "Content-Type": "text/plain" }));
    expect(wrongType.status).toBe(415);
    expect(withDatabase).not.toHaveBeenCalled();
    expect(crossOrigin.headers.get("Cache-Control")).toContain("private, no-store");
  });

  it.each(cases)("sanitizes failures and prevents caching for $path", async ({ path, handler, body }) => {
    vi.mocked(withDatabase).mockRejectedValueOnce(new Error("synthetic-private-database-detail"));
    const response = await handler(request(path, body));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "embedding_index_unavailable" });
    expect(response.headers.get("Cache-Control")).toContain("private, no-store");
  });

  it("returns claims with the shared contract and preserves the nested document", async () => {
    const claims = [{
      bookmarkId, document: { text: "Synthetic post", quotedText: null, note: null, tags: [] },
      contentHash, claimToken, leaseExpiresAt: future.toISOString(),
    }];
    vi.mocked(withDatabase).mockResolvedValueOnce(claims);
    const response = await claimPost(request("claim", { limit: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claims, contract: EMBEDDING_CONTRACT });
  });

  it("returns persisted index counts with private caching", async () => {
    const counts = { total: 7, ready: 1, pending: 2, processing: 1, stale: 1, failed: 2 };
    vi.mocked(withDatabase).mockResolvedValueOnce(counts);
    const response = await statusGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(counts);
    expect(response.headers.get("Cache-Control")).toContain("private, no-store");
  });

  it("sanitizes status errors", async () => {
    vi.mocked(withDatabase).mockRejectedValueOnce(new Error("synthetic-private-database-detail"));
    const response = await statusGet();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "embedding_index_unavailable" });
  });

  it("returns the bounded retry count and rejects excessive retry requests", async () => {
    vi.mocked(withDatabase).mockResolvedValueOnce(2);
    const response = await retryPost(request("retry", { limit: 2 }));
    expect(await response.json()).toEqual({ retried: 2 });
    vi.mocked(withDatabase).mockClear();
    expect((await retryPost(request("retry", { limit: 11 }))).status).toBe(422);
    expect(withDatabase).not.toHaveBeenCalled();
  });

  it.each(["completed", "already_completed"])("acknowledges %s", async (outcome) => {
    vi.mocked(withDatabase).mockResolvedValueOnce(outcome);
    const response = await completePost(request("complete", input));
    expect(await response.json()).toEqual({ completed: true, alreadyCompleted: outcome === "already_completed" });
  });

  it.each(["pending", "failed"])("reports the recorded failure status %s", async (status) => {
    vi.mocked(withDatabase).mockResolvedValueOnce(status);
    const response = await failPost(request("fail", { bookmarkId, claimToken, errorCode: "embedding_failed" }));
    expect(await response.json()).toEqual({ recorded: true, status });
  });

  it.each([completePost, failPost])("maps missing and conflicting claims to private errors", async (handler) => {
    const body = handler === completePost ? input : { bookmarkId, claimToken, errorCode: "embedding_failed" };
    vi.mocked(withDatabase).mockResolvedValueOnce("not_found");
    expect((await handler(request("test", body))).status).toBe(404);
    vi.mocked(withDatabase).mockResolvedValueOnce("conflict");
    expect((await handler(request("test", body))).status).toBe(409);
  });

  it("rejects excessive bodies and unapproved errors without opening the database", async () => {
    const oversized = await completePost(request("complete", { ...input, ignored: "x".repeat(33_000) }));
    expect(oversized.status).toBe(413);
    const error = await failPost(request("fail", { bookmarkId, claimToken, errorCode: "synthetic-private-text" }));
    expect(error.status).toBe(422);
    expect(await error.text()).not.toContain("synthetic-private-text");
    expect(withDatabase).not.toHaveBeenCalled();
  });
});
