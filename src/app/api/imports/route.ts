import { and, desc, eq, inArray } from "drizzle-orm";
import { importBatches, importJobs } from "@/db/schema";
import { withDatabase } from "@/db";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";
import { createImportJobSchema } from "@/lib/import/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_LIMIT_BYTES = 16 * 1024;

function matchesResumeRequest(
  job: typeof importJobs.$inferSelect,
  input: {
    totalSeen: number;
    expectedBatches: number;
    duplicateWithinFile: number;
    invalid: number;
  },
) {
  return job.totalSeen === input.totalSeen
    && job.expectedBatches === input.expectedBatches
    && job.duplicateWithinFile === input.duplicateWithinFile
    && job.invalid === input.invalid;
}

async function responseForJob(job: typeof importJobs.$inferSelect, resumed: boolean) {
  const completed = await withDatabase((db) => db
    .select({ batchNumber: importBatches.batchNumber })
    .from(importBatches)
    .where(and(eq(importBatches.jobId, job.id), eq(importBatches.status, "completed"))));

  return jsonResponse({
    job: {
      id: job.id,
      sourceFormat: job.sourceFormat,
      status: job.status,
      totalSeen: job.totalSeen,
      expectedBatches: job.expectedBatches,
      inserted: job.inserted,
      enriched: job.enriched,
      alreadyExisting: job.alreadyExisting,
      duplicateWithinFile: job.duplicateWithinFile,
      invalid: job.invalid,
      failed: job.failed,
      createdAt: job.createdAt,
    },
    completedBatchNumbers: completed.map((batch) => batch.batchNumber),
    resumed,
  }, resumed ? 200 : 201);
}

export async function GET() {
  try {
    const jobs = await withDatabase((db) => db
      .select({
        id: importJobs.id,
        sourceFormat: importJobs.sourceFormat,
        status: importJobs.status,
        totalSeen: importJobs.totalSeen,
        expectedBatches: importJobs.expectedBatches,
        inserted: importJobs.inserted,
        enriched: importJobs.enriched,
        alreadyExisting: importJobs.alreadyExisting,
        duplicateWithinFile: importJobs.duplicateWithinFile,
        invalid: importJobs.invalid,
        failed: importJobs.failed,
        createdAt: importJobs.createdAt,
        updatedAt: importJobs.updatedAt,
      })
      .from(importJobs)
      .orderBy(desc(importJobs.createdAt))
      .limit(20));
    return jsonResponse({ jobs });
  } catch {
    return apiError("database_unavailable", 503);
  }
}

export async function POST(request: Request) {
  const body = await readJsonRequest(request, createImportJobSchema, JSON_LIMIT_BYTES);
  if (!body.ok) return body.response;

  try {
    const outcome = await withDatabase((db) => db.transaction(async (tx) => {
      const active = await tx
        .select()
        .from(importJobs)
        .where(and(
          eq(importJobs.sourceFormat, body.data.sourceFormat),
          eq(importJobs.sourceFileHash, body.data.fileHash),
          inArray(importJobs.status, ["pending", "processing"]),
        ))
        .orderBy(desc(importJobs.createdAt))
        .limit(1)
        .for("update");

      if (active[0]) {
        return {
          job: active[0],
          resumed: true,
          matches: matchesResumeRequest(active[0], body.data),
        };
      }

      const [created] = await tx
        .insert(importJobs)
        .values({
          sourceFormat: body.data.sourceFormat,
          sourceFileHash: body.data.fileHash,
          status: body.data.expectedBatches === 0 ? "completed" : "pending",
          totalSeen: body.data.totalSeen,
          expectedBatches: body.data.expectedBatches,
          duplicateWithinFile: body.data.duplicateWithinFile,
          invalid: body.data.invalid,
        })
        .onConflictDoNothing()
        .returning();

      if (created) return { job: created, resumed: false, matches: true };

      const raced = await tx
        .select()
        .from(importJobs)
        .where(and(
          eq(importJobs.sourceFormat, body.data.sourceFormat),
          eq(importJobs.sourceFileHash, body.data.fileHash),
          inArray(importJobs.status, ["pending", "processing"]),
        ))
        .orderBy(desc(importJobs.createdAt))
        .limit(1)
        .for("update");
      if (!raced[0]) throw new Error("active_import_race_unresolved");
      return { job: raced[0], resumed: true, matches: matchesResumeRequest(raced[0], body.data) };
    }));

    if (!outcome.matches) return apiError("resume_request_mismatch", 409);
    return await responseForJob(outcome.job, outcome.resumed);
  } catch {
    return apiError("database_unavailable", 503);
  }
}
