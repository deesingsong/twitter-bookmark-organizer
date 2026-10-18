import "server-only";

import { sql } from "drizzle-orm";
import type { Database } from "@/db";
import { bookmarkEmbeddings, bookmarks } from "@/db/schema";
import { EMBEDDING_CONTRACT } from "./contracts";
import { hasSemanticContent, MAX_EMBEDDING_ATTEMPTS } from "./indexing";

export interface EmbeddingIndexStatus {
  total: number;
  ready: number;
  pending: number;
  processing: number;
  stale: number;
  failed: number;
}

/** Counts only live bookmarks with semantic content; missing rows are pending. */
export async function readEmbeddingIndexStatus(db: Database): Promise<EmbeddingIndexStatus> {
  const result = await db.execute<EmbeddingIndexStatus & Record<string, unknown>>(sql`
    with index_states as (
      select case
        when ${bookmarkEmbeddings.bookmarkId} is null then 'pending'
        when ${bookmarkEmbeddings.status} = 'processing'
          and ${bookmarkEmbeddings.leaseExpiresAt} <= clock_timestamp()
          then case when ${bookmarkEmbeddings.attemptCount} < ${MAX_EMBEDDING_ATTEMPTS}
            then 'pending' else 'failed' end
        when ${bookmarkEmbeddings.status} = 'ready' and (
          ${bookmarkEmbeddings.modelId} <> ${EMBEDDING_CONTRACT.modelId}
          or ${bookmarkEmbeddings.modelRevision} <> ${EMBEDDING_CONTRACT.modelRevision}
          or ${bookmarkEmbeddings.dimensions} <> ${EMBEDDING_CONTRACT.dimensions}
          or ${bookmarkEmbeddings.preprocessingVersion} <> ${EMBEDDING_CONTRACT.preprocessingVersion}
          or ${bookmarkEmbeddings.embedding} is null or ${bookmarkEmbeddings.indexedAt} is null
        ) then 'stale'
        else ${bookmarkEmbeddings.status}
      end as state
      from ${bookmarks}
      left join ${bookmarkEmbeddings} on ${bookmarkEmbeddings.bookmarkId} = ${bookmarks.id}
      where ${hasSemanticContent}
    )
    select count(*)::int as total,
      count(*) filter (where state = 'ready')::int as ready,
      count(*) filter (where state = 'pending')::int as pending,
      count(*) filter (where state = 'processing')::int as processing,
      count(*) filter (where state = 'stale')::int as stale,
      count(*) filter (where state = 'failed')::int as failed
    from index_states
  `);
  return result.rows[0];
}
