import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { withDatabase } from "@/db";
import { bookmarks, importBatches, importJobs } from "@/db/schema";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";
import { enrichMissingBookmarkFields } from "@/lib/import/bookmark-enrichment";
import { MAX_IMPORT_BATCH_BYTES } from "@/lib/import/batches";
import { importBatchSchema } from "@/lib/import/contracts";
import type { NormalizedBookmark } from "@/lib/import/twitter-bookmarks-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class BookmarkIdentityConflictError extends Error {}

function payloadHash(records: NormalizedBookmark[]): string {
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const body = await readJsonRequest(request, importBatchSchema, MAX_IMPORT_BATCH_BYTES);
  if (!body.ok) return body.response;
  const { jobId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return apiError("import_job_not_found", 404);
  }

  const identities = new Set<string>();
  if (body.data.records.some((record) => {
    if (identities.has(record.tweetId)) return true;
    identities.add(record.tweetId);
    return false;
  })) return apiError("duplicate_identity_in_batch", 422);

  const hash = payloadHash(body.data.records);
  try {
    const outcome = await withDatabase((db) => db.transaction(async (tx) => {
      const [job] = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).for("update");
      if (!job) return { kind: "not_found" as const };

      const [previous] = await tx.select().from(importBatches).where(and(
        eq(importBatches.jobId, job.id), eq(importBatches.batchNumber, body.data.batchNumber),
      ));
      if (previous) {
        if (previous.status === "completed" && previous.payloadHash === hash) {
          return { kind: "replay" as const, batch: previous, job };
        }
        return { kind: "batch_conflict" as const };
      }
      if (!["pending", "processing"].includes(job.status)) return { kind: "job_closed" as const };
      if (body.data.batchNumber >= job.expectedBatches) return { kind: "batch_out_of_range" as const };

      await tx.insert(importBatches).values({
        jobId: job.id,
        batchNumber: body.data.batchNumber,
        recordCount: body.data.records.length,
        payloadHash: hash,
        status: "pending",
      });

      let inserted = 0;
      let enriched = 0;
      let alreadyExisting = 0;
      for (const record of body.data.records) {
        const values = {
          tweetId: record.tweetId,
          canonicalUrl: record.canonicalUrl,
          originalUrl: record.originalUrl,
          text: record.text,
          authorId: record.authorId,
          authorUsername: record.authorUsername,
          authorDisplayName: record.authorDisplayName,
          authorAvatarUrl: record.authorAvatarUrl,
          authorVerified: record.authorVerified,
          language: record.language,
          tweetCreatedAt: record.tweetCreatedAt ? new Date(record.tweetCreatedAt) : null,
          bookmarkedAt: record.bookmarkedAt ? new Date(record.bookmarkedAt) : null,
          lastSeenAt: record.lastSeenAt ? new Date(record.lastSeenAt) : null,
          sourceMetrics: record.sourceMetrics,
          mediaReferences: record.mediaReferences,
          quotedTweet: record.quotedTweet,
          sourceMetadata: record.sourceMetadata,
          hasMedia: record.hasMedia,
        };
        const [created] = await tx.insert(bookmarks).values(values).onConflictDoNothing().returning({ id: bookmarks.id });
        if (created) {
          inserted++;
          continue;
        }

        const matches = await tx.select().from(bookmarks).where(or(
          eq(bookmarks.tweetId, record.tweetId),
          eq(bookmarks.canonicalUrl, record.canonicalUrl),
        )).limit(2).for("update");
        if (matches.length !== 1 || matches[0].tweetId !== record.tweetId) {
          throw new BookmarkIdentityConflictError("bookmark_identity_conflict");
        }
        const updates = enrichMissingBookmarkFields(matches[0], record);
        if (Object.keys(updates).length > 0) {
          await tx.update(bookmarks).set(updates).where(eq(bookmarks.id, matches[0].id));
          enriched++;
        } else {
          alreadyExisting++;
        }
      }

      const [completed] = await tx.update(importBatches).set({
        status: "completed",
        inserted,
        enriched,
        alreadyExisting,
        completedAt: new Date(),
      }).where(and(
        eq(importBatches.jobId, job.id), eq(importBatches.batchNumber, body.data.batchNumber),
      )).returning();

      const done = await tx.select({ value: sql<number>`count(*)::int` })
        .from(importBatches)
        .where(and(eq(importBatches.jobId, job.id), eq(importBatches.status, "completed")));
      const nextJobStatus = done[0].value >= job.expectedBatches ? "completed" : "processing";
      const [updatedJob] = await tx.update(importJobs).set({
        status: nextJobStatus,
        inserted: job.inserted + inserted,
        enriched: job.enriched + enriched,
        alreadyExisting: job.alreadyExisting + alreadyExisting,
        updatedAt: new Date(),
      }).where(eq(importJobs.id, job.id)).returning();

      return { kind: "accepted" as const, batch: completed, job: updatedJob };
    }));

    if (outcome.kind === "not_found") return apiError("import_job_not_found", 404);
    if (outcome.kind === "job_closed") return apiError("import_job_closed", 409);
    if (outcome.kind === "batch_out_of_range") return apiError("batch_out_of_range", 422);
    if (outcome.kind === "batch_conflict") return apiError("batch_replay_conflict", 409);
    return jsonResponse({
      job: {
        id: outcome.job.id,
        status: outcome.job.status,
        totalSeen: outcome.job.totalSeen,
        expectedBatches: outcome.job.expectedBatches,
        inserted: outcome.job.inserted,
        enriched: outcome.job.enriched,
        alreadyExisting: outcome.job.alreadyExisting,
        duplicateWithinFile: outcome.job.duplicateWithinFile,
        invalid: outcome.job.invalid,
        failed: outcome.job.failed,
      },
      batch: {
        batchNumber: outcome.batch.batchNumber,
        status: outcome.batch.status,
        inserted: outcome.batch.inserted,
        enriched: outcome.batch.enriched,
        alreadyExisting: outcome.batch.alreadyExisting,
        replayed: outcome.kind === "replay",
      },
    }, outcome.kind === "accepted" ? 200 : 200);
  } catch (error) {
    if (error instanceof BookmarkIdentityConflictError) return apiError("bookmark_identity_conflict", 409);
    return apiError("import_batch_failed", 503);
  }
}
