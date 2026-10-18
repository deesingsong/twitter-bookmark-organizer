import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "@/db";
import { bookmarkEmbeddings, bookmarks } from "@/db/schema";
import { EMBEDDING_CONTRACT } from "@/lib/embeddings/contracts";
import { POST } from "@/app/api/bookmarks/search/route";

vi.mock("server-only", () => ({}));

const enabled = process.env.RUN_SEMANTIC_SEARCH_DB_TESTS === "1";
let pool: Pool | undefined;
let db: Database;
let previousDatabaseUrl: string | undefined;
const queryVector = [1, ...Array<number>(383).fill(0)];
const orthogonalVector = [0, 1, ...Array<number>(382).fill(0)];

describe.skipIf(!enabled)("semantic search route against guarded bookmark_dev", () => {
  beforeAll(async () => {
    const connectionString = process.env.EMBEDDING_TEST_DATABASE_URL;
    if (!connectionString) throw new Error("EMBEDDING_TEST_DATABASE_URL_required");
    const target = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(target.protocol)
      || decodeURIComponent(target.pathname) !== "/bookmark_dev") {
      throw new Error("semantic_search_test_requires_bookmark_dev_URL");
    }
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = connectionString;
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
    db = createDatabase(pool);
    const result = await db.execute<{ name: string }>(sql`select current_database() as name`);
    if (result.rows[0]?.name !== "bookmark_dev") throw new Error("semantic_search_test_requires_bookmark_dev");
    const existing = await db.execute<{ count: number }>(sql`select count(*)::int as count from ${bookmarks}`);
    if (existing.rows[0]?.count !== 0) throw new Error("semantic_search_test_requires_empty_bookmark_dev");
  }, 15_000);

  afterAll(async () => {
    await pool?.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("ranks real pgvector candidates, applies filters, preserves hybrid exact priority and paginates", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    try {
      await db.insert(bookmarks).values([
        { id: firstId, tweetId: "90071992547409931", canonicalUrl: "https://x.com/alice/status/90071992547409931", text: "Synthetic planetary retrieval record alpha", authorUsername: "alice" },
        { id: secondId, tweetId: "90071992547409932", canonicalUrl: "https://x.com/bob/status/90071992547409932", text: "Synthetic botanical retrieval record beta", authorUsername: "bob" },
      ]);
      for (const row of [
        { bookmarkId: firstId, embedding: queryVector },
        { bookmarkId: secondId, embedding: orthogonalVector },
      ]) await db.insert(bookmarkEmbeddings).values({
        ...row, modelId: EMBEDDING_CONTRACT.modelId, modelRevision: EMBEDDING_CONTRACT.modelRevision,
        dimensions: EMBEDDING_CONTRACT.dimensions, preprocessingVersion: EMBEDDING_CONTRACT.preprocessingVersion,
        contentHash: "a".repeat(64), status: "ready", indexedAt: new Date(),
      });

      const postSearch = async (input: Record<string, unknown>) => POST(new Request("https://library.test/api/bookmarks/search", {
        method: "POST", headers: { "content-type": "application/json", origin: "https://library.test" },
        body: JSON.stringify({ q: "planetary systems", mode: "meaning", contract: EMBEDDING_CONTRACT, queryVector, ...input }),
      }));

      const first = await postSearch({ limit: 1 });
      expect(first.status).toBe(200);
      const firstPage = await first.json() as { bookmarks: { id: string; matchKind: string }[]; nextCursor: string | null };
      expect(firstPage.bookmarks.map(({ id, matchKind }) => [id, matchKind])).toEqual([[firstId, "semantic"]]);
      expect(firstPage.nextCursor).toBeTruthy();

      const second = await postSearch({ limit: 1, cursor: firstPage.nextCursor });
      expect(second.status).toBe(200);
      const secondPage = await second.json() as { bookmarks: { id: string; matchKind: string }[]; nextCursor: string | null };
      expect(secondPage.bookmarks.map(({ id, matchKind }) => [id, matchKind])).toEqual([[secondId, "semantic"]]);
      expect(secondPage.nextCursor).toBeNull();

      const filtered = await postSearch({ author: "alice" });
      expect((await filtered.json()).bookmarks.map((row: { id: string }) => row.id)).toEqual([firstId]);

      const exact = await postSearch({ q: "90071992547409931", mode: "hybrid" });
      expect(exact.status).toBe(200);
      const exactBody = await exact.json() as { bookmarks: { id: string; matchKind: string }[] };
      expect(exactBody.bookmarks[0]).toMatchObject({ id: firstId, matchKind: "exact" });
    } finally {
      await db.delete(bookmarks).where(sql`${bookmarks.id} in (${firstId}::uuid, ${secondId}::uuid)`);
      const cleanup = await db.execute<{ bookmarks: number; embeddings: number }>(sql`
        select (select count(*)::int from ${bookmarks}) as bookmarks,
               (select count(*)::int from ${bookmarkEmbeddings}) as embeddings
      `);
      if (cleanup.rows[0]?.bookmarks !== 0 || cleanup.rows[0]?.embeddings !== 0) {
        throw new Error("semantic_search_synthetic_cleanup_failed");
      }
    }
  }, 30_000);
});
