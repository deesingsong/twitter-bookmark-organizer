import { z } from "zod";
import { MAX_ARCHIVE_RECORDS, NormalizedBookmarkSchema, TWITTER_BOOKMARKS_V1 } from "@/lib/import/twitter-bookmarks-v1";
import { MAX_IMPORT_BATCH_RECORDS } from "@/lib/import/batches";

export const createImportJobSchema = z.object({
  sourceFormat: z.literal(TWITTER_BOOKMARKS_V1),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  totalSeen: z.number().int().min(0).max(MAX_ARCHIVE_RECORDS),
  expectedBatches: z.number().int().min(0).max(MAX_ARCHIVE_RECORDS),
  duplicateWithinFile: z.number().int().min(0).max(MAX_ARCHIVE_RECORDS),
  invalid: z.number().int().min(0).max(MAX_ARCHIVE_RECORDS),
}).strict().superRefine((input, context) => {
  const remaining = input.totalSeen - input.duplicateWithinFile - input.invalid;
  if (remaining < 0) {
    context.addIssue({ code: "custom", path: ["totalSeen"], message: "Invalid outcome counts" });
    return;
  }
  if ((remaining === 0 && input.expectedBatches !== 0)
    || (remaining > 0 && (input.expectedBatches === 0
      || input.expectedBatches < Math.ceil(remaining / MAX_IMPORT_BATCH_RECORDS)
      || input.expectedBatches > remaining))) {
    context.addIssue({ code: "custom", path: ["expectedBatches"], message: "Invalid batch count" });
  }
});

export const importBatchSchema = z.object({
  batchNumber: z.number().int().min(0).max(MAX_ARCHIVE_RECORDS),
  records: z.array(NormalizedBookmarkSchema).min(1).max(MAX_IMPORT_BATCH_RECORDS),
}).strict();

export type CreateImportJobRequest = z.infer<typeof createImportJobSchema>;
export type ImportBatchRequest = z.infer<typeof importBatchSchema>;
