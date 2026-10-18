import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db";
import { bookmarkEmbeddings, bookmarks, bookmarkTags, tags } from "@/db/schema";
import {
  EMBEDDING_CONTRACT,
  normalizeEmbeddingVector,
  validateEmbeddingVector,
} from "./contracts";
import { embeddingDocumentHash } from "./preprocess";

export const MAX_EMBEDDING_CLAIMS = 10;
export const MAX_EMBEDDING_ATTEMPTS = 3;
export const EMBEDDING_LEASE_MS = 3 * 60 * 1000;

export const claimEmbeddingsSchema = z.object({
  limit: z.number().int().min(1).max(MAX_EMBEDDING_CLAIMS),
}).strict();

const vectorSchema = z.array(z.number()).length(EMBEDDING_CONTRACT.dimensions)
  .superRefine((value, context) => {
    try {
      validateEmbeddingVector(value);
    } catch {
      context.addIssue({ code: "custom", message: "invalid_embedding_vector" });
    }
  });

export const completeEmbeddingSchema = z.object({
  bookmarkId: z.string().uuid(),
  claimToken: z.string().uuid(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  vector: vectorSchema,
}).strict();

export const failEmbeddingSchema = z.object({
  bookmarkId: z.string().uuid(),
  claimToken: z.string().uuid(),
  errorCode: z.enum([
    "model_unavailable",
    "model_load_failed",
    "embedding_failed",
    "unsupported_runtime",
    "indexing_cancelled",
  ]),
}).strict();

export type CompleteEmbeddingInput = z.infer<typeof completeEmbeddingSchema>;
export type FailEmbeddingInput = z.infer<typeof failEmbeddingSchema>;
type EmbeddingRow = typeof bookmarkEmbeddings.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type BookmarkContent = Pick<typeof bookmarks.$inferSelect, "id" | "text" | "quotedTweet" | "note">;

export interface EmbeddingClaimDocument {
  text: string | null;
  quotedText: string | null;
  note: string | null;
  tags: string[];
}

export interface EmbeddingClaim {
  bookmarkId: string;
  document: EmbeddingClaimDocument;
  contentHash: string;
  claimToken: string;
  leaseExpiresAt: string;
}

type ClaimState = Pick<EmbeddingRow, "status" | "attemptCount" | "leaseExpiresAt">;
type CompletionState = Pick<EmbeddingRow,
  "status" | "claimToken" | "leaseExpiresAt" | "contentHash" | "embedding" | "indexedAt"
  | "modelId" | "modelRevision" | "dimensions" | "preprocessingVersion"
>;

function hasCurrentContract(state: CompletionState): boolean {
  return state.modelId === EMBEDDING_CONTRACT.modelId
    && state.modelRevision === EMBEDDING_CONTRACT.modelRevision
    && state.dimensions === EMBEDDING_CONTRACT.dimensions
    && state.preprocessingVersion === EMBEDDING_CONTRACT.preprocessingVersion;
}

export function canClaimEmbedding(state: ClaimState | null, now: Date): boolean {
  if (!state) return true;
  if (state.attemptCount >= MAX_EMBEDDING_ATTEMPTS) return false;
  if (state.status === "pending" || state.status === "stale") return true;
  return state.status === "processing"
    && state.leaseExpiresAt !== null
    && state.leaseExpiresAt.getTime() <= now.getTime();
}

/** pgvector stores float32 components; an equivalent retry never writes a row. */
function sameStoredVector(stored: number[] | null, submitted: number[]): boolean {
  return stored?.length === submitted.length
    && stored.every((value, index) => Math.fround(value) === Math.fround(submitted[index]));
}

export function decideEmbeddingCompletion(
  state: CompletionState | null,
  input: CompleteEmbeddingInput,
  currentContentHash: string,
  now: Date,
): "complete" | "already_completed" | "conflict" | "not_found" {
  if (!state) return "not_found";
  if (!hasCurrentContract(state)
    || state.contentHash !== input.contentHash
    || currentContentHash !== input.contentHash) return "conflict";

  // A successful write clears its token. Only acknowledge an equivalent ready
  // value, with no mutation, when the response to that write may have been lost.
  if (state.status === "ready" && state.indexedAt !== null
    && sameStoredVector(state.embedding, input.vector)) return "already_completed";

  return state.status === "processing"
    && state.claimToken === input.claimToken
    && state.leaseExpiresAt !== null
    && state.leaseExpiresAt.getTime() > now.getTime()
    ? "complete" : "conflict";
}

export function decideEmbeddingFailure(
  state: Pick<EmbeddingRow, "status" | "claimToken" | "leaseExpiresAt" | "attemptCount"> | null,
  claimToken: string,
  now: Date,
): "pending" | "failed" | "conflict" | "not_found" {
  if (!state) return "not_found";
  if (state.status !== "processing" || state.claimToken !== claimToken
    || state.leaseExpiresAt === null || state.leaseExpiresAt.getTime() <= now.getTime()) {
    return "conflict";
  }
  return state.attemptCount >= MAX_EMBEDDING_ATTEMPTS ? "failed" : "pending";
}

async function configureTransaction(tx: Transaction): Promise<void> {
  await tx.execute(sql`select set_config('statement_timeout', '8s', true), set_config('lock_timeout', '2s', true)`);
}

async function databaseNow(tx: Transaction): Promise<Date> {
  const result = await tx.execute<{ milliseconds: string }>(
    sql`select extract(epoch from clock_timestamp()) * 1000 as milliseconds`,
  );
  return new Date(Number(result.rows[0].milliseconds));
}

const bookmarkContentSelection = {
  id: bookmarks.id,
  text: bookmarks.text,
  quotedTweet: bookmarks.quotedTweet,
  note: bookmarks.note,
};

async function readDocument(tx: Transaction, bookmark: BookmarkContent): Promise<EmbeddingClaimDocument> {
  const assignedTags = await tx.select({ name: tags.name }).from(bookmarkTags)
    .innerJoin(tags, eq(tags.id, bookmarkTags.tagId))
    .where(eq(bookmarkTags.bookmarkId, bookmark.id));
  return {
    text: bookmark.text,
    quotedText: typeof bookmark.quotedTweet?.text === "string" ? bookmark.quotedTweet.text : null,
    note: bookmark.note,
    tags: assignedTags.map(({ name }) => name)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  };
}

/** Claims never synthesize searchable text for records containing only IDs. */
export const hasSemanticContent = sql`(
  coalesce(${bookmarks.text}, '') ~ '[^[:space:]]'
  or coalesce(${bookmarks.note}, '') ~ '[^[:space:]]'
  or (jsonb_typeof(${bookmarks.quotedTweet}->'text') = 'string'
    and (${bookmarks.quotedTweet}->>'text') ~ '[^[:space:]]')
  or exists (
    select 1 from ${bookmarkTags} inner join ${tags} on ${tags.id} = ${bookmarkTags.tagId}
    where ${bookmarkTags.bookmarkId} = ${bookmarks.id} and ${tags.name} ~ '[^[:space:]]'
  )
)`;

export async function claimEmbeddings(db: Database, limit: number): Promise<EmbeddingClaim[]> {
  // Also guard direct server callers, before opening a transaction.
  claimEmbeddingsSchema.parse({ limit });
  return db.transaction(async (tx) => {
    await configureTransaction(tx);

    // A browser that disappears during its final attempt cannot leave a row in
    // processing forever. Cleanup and the actual claim set are both bounded.
    const exhausted = await tx.select({ bookmarkId: bookmarkEmbeddings.bookmarkId })
      .from(bookmarkEmbeddings).where(and(
        eq(bookmarkEmbeddings.status, "processing"),
        eq(bookmarkEmbeddings.attemptCount, MAX_EMBEDDING_ATTEMPTS),
        lte(bookmarkEmbeddings.leaseExpiresAt, sql`clock_timestamp()`),
      )).orderBy(bookmarkEmbeddings.leaseExpiresAt, bookmarkEmbeddings.bookmarkId)
      .limit(MAX_EMBEDDING_CLAIMS).for("update", { skipLocked: true });
    if (exhausted.length > 0) {
      await tx.update(bookmarkEmbeddings).set({
        status: "failed", embedding: null, indexedAt: null,
        claimToken: null, leaseExpiresAt: null, lastError: "lease_expired",
      }).where(inArray(bookmarkEmbeddings.bookmarkId, exhausted.map(({ bookmarkId }) => bookmarkId)));
    }

    // Lock bookmarks first, matching completion, edits and deletion. The outer
    // join lets an existing archive acquire its first embedding row on demand.
    const candidates = await tx.select({
      ...bookmarkContentSelection,
      embeddingId: bookmarkEmbeddings.bookmarkId,
    }).from(bookmarks).leftJoin(bookmarkEmbeddings, eq(bookmarkEmbeddings.bookmarkId, bookmarks.id))
      .where(and(hasSemanticContent, or(
        isNull(bookmarkEmbeddings.bookmarkId),
        and(inArray(bookmarkEmbeddings.status, ["pending", "stale"]),
          lt(bookmarkEmbeddings.attemptCount, MAX_EMBEDDING_ATTEMPTS)),
        and(eq(bookmarkEmbeddings.status, "processing"),
          lt(bookmarkEmbeddings.attemptCount, MAX_EMBEDDING_ATTEMPTS),
          lte(bookmarkEmbeddings.leaseExpiresAt, sql`clock_timestamp()`)),
      ))).orderBy(bookmarks.id).limit(limit)
      .for("update", { of: bookmarks, skipLocked: true });

    const claims: EmbeddingClaim[] = [];
    for (const bookmark of candidates) {
      let [embedding] = await tx.select().from(bookmarkEmbeddings)
        .where(eq(bookmarkEmbeddings.bookmarkId, bookmark.id))
        .for("update", { skipLocked: true });
      // A tag rename may hold the embedding lock without holding the bookmark.
      if (!embedding && bookmark.embeddingId !== null) continue;
      const now = await databaseNow(tx);
      if (!canClaimEmbedding(embedding ?? null, now)) continue;
      const document = await readDocument(tx, bookmark);
      const contentHash = await embeddingDocumentHash(document);
      if (!embedding) {
        [embedding] = await tx.insert(bookmarkEmbeddings).values({
          bookmarkId: bookmark.id,
          modelId: EMBEDDING_CONTRACT.modelId,
          modelRevision: EMBEDDING_CONTRACT.modelRevision,
          dimensions: EMBEDDING_CONTRACT.dimensions,
          preprocessingVersion: EMBEDDING_CONTRACT.preprocessingVersion,
          contentHash,
          status: "pending",
        }).onConflictDoNothing().returning();
        if (!embedding) continue;
      }
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + EMBEDDING_LEASE_MS);
      await tx.update(bookmarkEmbeddings).set({
        modelId: EMBEDDING_CONTRACT.modelId,
        modelRevision: EMBEDDING_CONTRACT.modelRevision,
        dimensions: EMBEDDING_CONTRACT.dimensions,
        preprocessingVersion: EMBEDDING_CONTRACT.preprocessingVersion,
        contentHash,
        status: "processing",
        claimToken,
        leaseExpiresAt,
        attemptCount: embedding.attemptCount + 1,
        indexedAt: null,
        lastError: null,
      }).where(eq(bookmarkEmbeddings.bookmarkId, bookmark.id));
      claims.push({ bookmarkId: bookmark.id, document, contentHash, claimToken, leaseExpiresAt: leaseExpiresAt.toISOString() });
    }
    return claims;
  });
}

export async function completeEmbedding(
  db: Database,
  input: CompleteEmbeddingInput,
): Promise<"completed" | "already_completed" | "conflict" | "not_found"> {
  const normalized = { ...input, vector: normalizeEmbeddingVector(input.vector) };
  return db.transaction(async (tx) => {
    await configureTransaction(tx);
    const [bookmark] = await tx.select(bookmarkContentSelection).from(bookmarks)
      .where(eq(bookmarks.id, input.bookmarkId)).for("update");
    if (!bookmark) return "not_found";
    const [embedding] = await tx.select().from(bookmarkEmbeddings)
      .where(eq(bookmarkEmbeddings.bookmarkId, bookmark.id)).for("update");
    if (!embedding) return "not_found";

    const currentHash = await embeddingDocumentHash(await readDocument(tx, bookmark));
    const now = await databaseNow(tx);
    const decision = decideEmbeddingCompletion(embedding, normalized, currentHash, now);
    if (decision !== "complete") return decision;

    await tx.update(bookmarkEmbeddings).set({
      status: "ready",
      embedding: normalized.vector,
      indexedAt: now,
      claimToken: null,
      leaseExpiresAt: null,
      lastError: null,
    }).where(eq(bookmarkEmbeddings.bookmarkId, bookmark.id));
    return "completed";
  });
}

export async function failEmbedding(
  db: Database,
  input: FailEmbeddingInput,
): Promise<"pending" | "failed" | "conflict" | "not_found"> {
  // A direct server caller must not turn an exception message into stored data.
  failEmbeddingSchema.parse(input);
  return db.transaction(async (tx) => {
    await configureTransaction(tx);
    const [bookmark] = await tx.select({ id: bookmarks.id }).from(bookmarks)
      .where(eq(bookmarks.id, input.bookmarkId)).for("update");
    if (!bookmark) return "not_found";
    const [embedding] = await tx.select().from(bookmarkEmbeddings)
      .where(eq(bookmarkEmbeddings.bookmarkId, bookmark.id)).for("update");
    const decision = decideEmbeddingFailure(embedding ?? null, input.claimToken, await databaseNow(tx));
    if (decision === "not_found" || decision === "conflict") return decision;

    await tx.update(bookmarkEmbeddings).set({
      status: decision,
      embedding: null,
      indexedAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      lastError: input.errorCode,
    }).where(eq(bookmarkEmbeddings.bookmarkId, bookmark.id));
    return decision;
  });
}
