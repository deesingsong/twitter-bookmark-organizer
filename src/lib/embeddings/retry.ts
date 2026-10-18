import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db";
import { bookmarkEmbeddings, bookmarks } from "@/db/schema";
import { claimEmbeddingsSchema, hasSemanticContent, MAX_EMBEDDING_ATTEMPTS } from "./indexing";

// Expired final claims are reported as failed by the read-only status query.
// Accept them directly so explicit retry does not depend on another claim pass.
const retryableFailure = sql`(
  ${bookmarkEmbeddings.status} = 'failed'
  or (${bookmarkEmbeddings.status} = 'processing'
    and ${bookmarkEmbeddings.attemptCount} >= ${MAX_EMBEDDING_ATTEMPTS}
    and ${bookmarkEmbeddings.leaseExpiresAt} <= clock_timestamp())
)`;

/** Explicit owner action: release a bounded failed set for new browser work. */
export async function retryFailedEmbeddings(db: Database, limit: number): Promise<number> {
  claimEmbeddingsSchema.parse({ limit });
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', '8s', true), set_config('lock_timeout', '2s', true)`);
    const candidates = await tx.select({ bookmarkId: bookmarks.id }).from(bookmarks)
      .innerJoin(bookmarkEmbeddings, eq(bookmarkEmbeddings.bookmarkId, bookmarks.id))
      .where(and(retryableFailure, hasSemanticContent))
      .orderBy(bookmarks.id).limit(limit).for("update", { of: bookmarks, skipLocked: true });
    let retried = 0;
    for (const candidate of candidates) {
      const [embedding] = await tx.select().from(bookmarkEmbeddings)
        .where(and(eq(bookmarkEmbeddings.bookmarkId, candidate.bookmarkId), retryableFailure))
        .for("update", { skipLocked: true });
      if (!embedding) continue;
      await tx.update(bookmarkEmbeddings).set({
        status: embedding.embedding === null ? "pending" : "stale",
        attemptCount: 0,
        claimToken: null,
        leaseExpiresAt: null,
        indexedAt: null,
        lastError: null,
      }).where(eq(bookmarkEmbeddings.bookmarkId, candidate.bookmarkId));
      retried++;
    }
    return retried;
  });
}
