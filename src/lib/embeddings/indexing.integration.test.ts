import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase, type Database } from "@/db";
import { bookmarkEmbeddings, bookmarks, bookmarkTags, tags } from "@/db/schema";
import { EMBEDDING_CONTRACT } from "./contracts";
import { embeddingDocumentHash } from "./preprocess";
import { claimEmbeddings, completeEmbedding, failEmbedding } from "./indexing";
import { readEmbeddingIndexStatus } from "./status";
import { retryFailedEmbeddings } from "./retry";

vi.mock("server-only", () => ({}));

// No dotenv loading: an operator must explicitly opt in and select the test DB.
const enabled = process.env.RUN_EMBEDDING_INDEXING_DB_TESTS === "1";
let pool: Pool | undefined;
let db: Database;
const syntheticVector = [3, 4, ...Array<number>(382).fill(0)];

describe.skipIf(!enabled)("embedding indexing on guarded bookmark_dev", () => {
  beforeAll(async () => {
    const connectionString = process.env.EMBEDDING_TEST_DATABASE_URL;
    if (!connectionString) throw new Error("EMBEDDING_TEST_DATABASE_URL_required");
    const target = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(target.protocol)
      || decodeURIComponent(target.pathname) !== "/bookmark_dev") {
      throw new Error("embedding_tests_require_bookmark_dev_URL");
    }
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 10_000 });
    db = createDatabase(pool);
    const result = await db.execute<{ name: string }>(sql`select current_database() as name`);
    if (result.rows[0]?.name !== "bookmark_dev") {
      throw new Error("embedding_tests_require_current_database_bookmark_dev");
    }
  }, 15_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function withSyntheticBookmark(
    operation: (fixture: {
      bookmarkId: string;
      claimToken: string;
      contentHash: string;
      tagId: string;
    }) => Promise<void>,
  ) {
    const bookmarkId = randomUUID();
    const tagId = randomUUID();
    const claimToken = randomUUID();
    const document = {
      text: "Synthetic local embedding integration post",
      quotedText: "Synthetic quoted context",
      note: "Synthetic owner note",
      tags: [`synthetic-indexing-${tagId}`],
    };
    const contentHash = await embeddingDocumentHash(document);
    try {
      await db.insert(bookmarks).values({
        id: bookmarkId,
        canonicalUrl: `https://example.test/synthetic/${bookmarkId}`,
        text: document.text,
        quotedTweet: { text: document.quotedText },
        note: document.note,
      });
      await db.insert(tags).values({ id: tagId, name: document.tags[0] });
      await db.insert(bookmarkTags).values({ bookmarkId, tagId });
      await db.insert(bookmarkEmbeddings).values({
        bookmarkId,
        modelId: EMBEDDING_CONTRACT.modelId,
        modelRevision: EMBEDDING_CONTRACT.modelRevision,
        dimensions: EMBEDDING_CONTRACT.dimensions,
        preprocessingVersion: EMBEDDING_CONTRACT.preprocessingVersion,
        contentHash,
        status: "processing",
        claimToken,
        leaseExpiresAt: sql`clock_timestamp() + interval '3 minutes'`,
        attemptCount: 1,
      });
      await operation({ bookmarkId, claimToken, contentHash, tagId });
    } finally {
      // Deletion cascades embeddings and joins; only our generated IDs are used.
      try {
        await db.delete(bookmarks).where(eq(bookmarks.id, bookmarkId));
      } finally {
        await db.delete(tags).where(eq(tags.id, tagId));
      }
    }
  }

  it("stores normalized vectors, safely replays success, and invalidates changed owner tags", async () => {
    await withSyntheticBookmark(async ({ bookmarkId, claimToken, contentHash, tagId }) => {
      const input = { bookmarkId, claimToken, contentHash, vector: syntheticVector };
      expect(await completeEmbedding(db, input)).toBe("completed");
      const [ready] = await db.select().from(bookmarkEmbeddings).where(eq(bookmarkEmbeddings.bookmarkId, bookmarkId));
      expect(ready.status).toBe("ready");
      expect(ready.claimToken).toBeNull();
      expect(ready.leaseExpiresAt).toBeNull();
      expect(ready.embedding?.[0]).toBeCloseTo(0.6, 6);
      expect(ready.embedding?.[1]).toBeCloseTo(0.8, 6);
      expect(await completeEmbedding(db, input)).toBe("already_completed");
      await db.update(tags).set({ name: `synthetic-renamed-${tagId}` }).where(eq(tags.id, tagId));
      expect(await completeEmbedding(db, input)).toBe("conflict");
    });
  }, 15_000);

  it("rejects old tokens, changed content, expiry and deleted bookmarks without recreating rows", async () => {
    await withSyntheticBookmark(async ({ bookmarkId, claimToken, contentHash }) => {
      const input = { bookmarkId, claimToken, contentHash, vector: syntheticVector };
      expect(await completeEmbedding(db, { ...input, claimToken: randomUUID() })).toBe("conflict");
      expect(await completeEmbedding(db, { ...input, contentHash: "0".repeat(64) })).toBe("conflict");
      await db.update(bookmarkEmbeddings).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(bookmarkEmbeddings.bookmarkId, bookmarkId));
      expect(await completeEmbedding(db, input)).toBe("conflict");
      expect(await failEmbedding(db, { bookmarkId, claimToken, errorCode: "embedding_failed" })).toBe("conflict");
      await db.update(bookmarks).set({ note: "Synthetic changed note" }).where(eq(bookmarks.id, bookmarkId));
      expect(await completeEmbedding(db, input)).toBe("conflict");
      await db.delete(bookmarks).where(eq(bookmarks.id, bookmarkId));
      expect(await completeEmbedding(db, input)).toBe("not_found");
      expect(await failEmbedding(db, { bookmarkId, claimToken, errorCode: "embedding_failed" })).toBe("not_found");
      expect(await db.select({ id: bookmarks.id }).from(bookmarks).where(eq(bookmarks.id, bookmarkId))).toEqual([]);
      expect(await db.select({ id: bookmarkEmbeddings.bookmarkId }).from(bookmarkEmbeddings)
        .where(eq(bookmarkEmbeddings.bookmarkId, bookmarkId))).toEqual([]);
    });
  }, 15_000);

  it("records sanitized failures and stops automatic retries after three attempts", async () => {
    await withSyntheticBookmark(async ({ bookmarkId, claimToken }) => {
      expect(await failEmbedding(db, { bookmarkId, claimToken, errorCode: "model_load_failed" })).toBe("pending");
      const replacementToken = randomUUID();
      await db.update(bookmarkEmbeddings).set({
        status: "processing", claimToken: replacementToken,
        leaseExpiresAt: sql`clock_timestamp() + interval '3 minutes'`, attemptCount: 3,
      }).where(eq(bookmarkEmbeddings.bookmarkId, bookmarkId));
      expect(await failEmbedding(db, { bookmarkId, claimToken, errorCode: "embedding_failed" })).toBe("conflict");
      expect(await failEmbedding(db, { bookmarkId, claimToken: replacementToken, errorCode: "embedding_failed" }))
        .toBe("failed");
      const [failed] = await db.select().from(bookmarkEmbeddings).where(eq(bookmarkEmbeddings.bookmarkId, bookmarkId));
      expect(failed.lastError).toBe("embedding_failed");
      expect(failed.attemptCount).toBe(3);
      expect(failed.claimToken).toBeNull();
    });
  }, 15_000);

  it("serializes deletion with completion so no vector survives the deleted bookmark", async () => {
    await withSyntheticBookmark(async ({ bookmarkId, claimToken, contentHash }) => {
      const [outcome] = await Promise.all([
        completeEmbedding(db, { bookmarkId, claimToken, contentHash, vector: syntheticVector }),
        db.delete(bookmarks).where(eq(bookmarks.id, bookmarkId)),
      ]);
      expect(["completed", "not_found"]).toContain(outcome);
      expect(await db.select({ id: bookmarkEmbeddings.bookmarkId }).from(bookmarkEmbeddings)
        .where(eq(bookmarkEmbeddings.bookmarkId, bookmarkId))).toEqual([]);
    });
  }, 15_000);

  it("claims concurrently, resumes expired leases and explicitly retries failures in an empty dev DB", async (context) => {
    // claim/retry scan the queue by design. Refuse to touch pre-existing data.
    const before = await db.execute<{ count: number }>(sql`select count(*)::int as count from ${bookmarks}`);
    if (before.rows[0].count !== 0) context.skip("claim/retry tests require an otherwise empty bookmark_dev");
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    try {
      await db.insert(bookmarks).values(ids.map((id, index) => ({
        id, canonicalUrl: `https://example.test/synthetic/${id}`,
        text: index < 2 ? "Synthetic bounded queue post" : null,
      })));
      expect(await readEmbeddingIndexStatus(db)).toEqual({
        total: 2, ready: 0, pending: 2, processing: 0, stale: 0, failed: 0,
      });
      const results = await Promise.all([claimEmbeddings(db, 1), claimEmbeddings(db, 1)]);
      const claims = results.flat();
      expect(claims).toHaveLength(2);
      expect(new Set(claims.map(({ bookmarkId }) => bookmarkId)).size).toBe(2);
      expect(claims.every(({ document }) => document.text === "Synthetic bounded queue post")).toBe(true);
      const first = claims[0];
      await db.update(bookmarkEmbeddings).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(bookmarkEmbeddings.bookmarkId, first.bookmarkId));
      expect(await readEmbeddingIndexStatus(db)).toEqual({
        total: 2, ready: 0, pending: 1, processing: 1, stale: 0, failed: 0,
      });
      const [reclaimed] = await claimEmbeddings(db, 1);
      expect(reclaimed.bookmarkId).toBe(first.bookmarkId);
      expect(reclaimed.claimToken).not.toBe(first.claimToken);
      expect(await completeEmbedding(db, { ...first, vector: syntheticVector })).toBe("conflict");
      await db.update(bookmarkEmbeddings).set({
        attemptCount: 3, leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      }).where(eq(bookmarkEmbeddings.bookmarkId, first.bookmarkId));
      expect((await readEmbeddingIndexStatus(db)).failed).toBe(1);
      // A reported exhausted lease can be retried without loading the model or
      // invoking the claim cleanup path first.
      expect(await retryFailedEmbeddings(db, 1)).toBe(1);
      const [retry] = await claimEmbeddings(db, 1);
      expect(retry.bookmarkId).toBe(first.bookmarkId);
      const [state] = await db.select().from(bookmarkEmbeddings)
        .where(eq(bookmarkEmbeddings.bookmarkId, first.bookmarkId));
      expect(state.attemptCount).toBe(1);
      expect(state.lastError).toBeNull();

      await db.update(bookmarkEmbeddings).set({
        status: "failed", claimToken: null, leaseExpiresAt: null,
        attemptCount: 3, lastError: "embedding_failed",
      }).where(inArray(bookmarkEmbeddings.bookmarkId, claims.map(({ bookmarkId }) => bookmarkId)));
      await db.update(bookmarkEmbeddings).set({ embedding: [1, ...Array<number>(383).fill(0)] })
        .where(eq(bookmarkEmbeddings.bookmarkId, first.bookmarkId));
      // Independent retry requests skip each other's bookmark locks, and retain
      // stale vectors without presenting them as current ready embeddings.
      expect(await Promise.all([retryFailedEmbeddings(db, 1), retryFailedEmbeddings(db, 1)]))
        .toEqual([1, 1]);
      expect(await readEmbeddingIndexStatus(db)).toEqual({
        total: 2, ready: 0, pending: 1, processing: 0, stale: 1, failed: 0,
      });
      const resetRows = await db.select().from(bookmarkEmbeddings)
        .where(inArray(bookmarkEmbeddings.bookmarkId, claims.map(({ bookmarkId }) => bookmarkId)));
      expect(resetRows.every(({ attemptCount, lastError, claimToken, leaseExpiresAt }) =>
        attemptCount === 0 && lastError === null && claimToken === null && leaseExpiresAt === null)).toBe(true);
    } finally {
      for (const id of ids) await db.delete(bookmarks).where(eq(bookmarks.id, id));
    }
  }, 20_000);
});
