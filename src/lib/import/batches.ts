import type { NormalizedBookmark } from "@/lib/import/twitter-bookmarks-v1";

export const MAX_IMPORT_BATCH_RECORDS = 100;
export const MAX_IMPORT_BATCH_BYTES = 512 * 1024;

export class ImportBatchTooLargeError extends Error {
  constructor(readonly recordIndex: number) {
    super("record_exceeds_batch_limit");
    this.name = "ImportBatchTooLargeError";
  }
}

function requestBytes(batchNumber: number, records: NormalizedBookmark[]): number {
  const body = JSON.stringify({ batchNumber, records });
  return new TextEncoder().encode(body).byteLength;
}

export function chunkBookmarks(
  bookmarks: NormalizedBookmark[],
  limits: { maxRecords?: number; maxBytes?: number } = {},
): NormalizedBookmark[][] {
  const maxRecords = limits.maxRecords ?? MAX_IMPORT_BATCH_RECORDS;
  const maxBytes = limits.maxBytes ?? MAX_IMPORT_BATCH_BYTES;
  const batches: NormalizedBookmark[][] = [];
  let current: NormalizedBookmark[] = [];

  for (const [recordIndex, bookmark] of bookmarks.entries()) {
    const next = [...current, bookmark];
    if (next.length > maxRecords || requestBytes(0, next) > maxBytes) {
      if (current.length === 0) throw new ImportBatchTooLargeError(recordIndex);
      batches.push(current);
      current = [bookmark];
      if (requestBytes(batches.length, current) > maxBytes) {
        throw new ImportBatchTooLargeError(recordIndex);
      }
    } else {
      current = next;
    }
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
