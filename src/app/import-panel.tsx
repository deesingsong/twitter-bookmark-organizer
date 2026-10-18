"use client";

import { useRef, useState } from "react";
import { chunkBookmarks } from "@/lib/import/batches";
import { ArchiveParseError, MAX_ARCHIVE_BYTES, parseTwitterBookmarksV1 } from "@/lib/import/twitter-bookmarks-v1";

type ImportSummary = {
  inserted: number;
  enriched: number;
  alreadyExisting: number;
  duplicateWithinFile: number;
  invalid: number;
  totalSeen: number;
};

const API_ERROR_MESSAGES: Record<string, string> = {
  database_unavailable: "The library is temporarily unavailable.",
  import_batch_failed: "This batch could not be saved.",
  import_job_closed: "This import has already closed.",
  resume_request_mismatch: "The selected file does not match the pending import.",
  batch_replay_conflict: "This batch number was already used for different data.",
  bookmark_identity_conflict: "A record conflicts with an existing bookmark identity.",
};

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ImportPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function importFile(file: File | undefined) {
    setError("");
    setSummary(null);
    if (!file) return;
    if (file.size > MAX_ARCHIVE_BYTES) {
      setError("This file exceeds the 25 MB import limit.");
      return;
    }
    setBusy(true);
    setProgress("Reading and checking the archive…");
    try {
      const parsed = parseTwitterBookmarksV1(await file.text());
      const batches = chunkBookmarks(parsed.bookmarks);
      const fileHash = await sha256(file);
      const created = await fetch("/api/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceFormat: parsed.sourceFormat,
          fileHash,
          totalSeen: parsed.totalSeen,
          expectedBatches: batches.length,
          duplicateWithinFile: parsed.duplicateWithinFile,
          invalid: parsed.invalidRecords.length,
        }),
      });
      const jobResponse = await created.json() as {
        error?: string;
        job?: { id: string; status: string; inserted: number; enriched: number; alreadyExisting: number };
        completedBatchNumbers?: number[];
      };
      if (!created.ok || !jobResponse.job) throw new Error(jobResponse.error ?? "Could not start the import.");

      const done = new Set(jobResponse.completedBatchNumbers ?? []);
      let currentCounts = {
        inserted: jobResponse.job.inserted,
        enriched: jobResponse.job.enriched,
        alreadyExisting: jobResponse.job.alreadyExisting,
      };
      for (let index = 0; index < batches.length; index++) {
        if (done.has(index)) continue;
        setProgress(`Saving batch ${index + 1} of ${batches.length}…`);
        const response = await fetch(`/api/imports/${jobResponse.job.id}/batches`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchNumber: index, records: batches[index] }),
        });
        const result = await response.json() as {
          error?: string;
          job?: typeof currentCounts;
        };
        if (!response.ok) throw new Error(result.error ?? `Batch ${index + 1} could not be saved.`);
        if (result.job) currentCounts = result.job;
      }

      setSummary({
        ...currentCounts,
        duplicateWithinFile: parsed.duplicateWithinFile,
        invalid: parsed.invalidRecords.length,
        totalSeen: parsed.totalSeen,
      });
      setProgress("Import complete.");
    } catch (cause) {
      const message = cause instanceof ArchiveParseError
        ? cause.code.replaceAll("_", " ")
        : cause instanceof Error
          ? API_ERROR_MESSAGES[cause.message] ?? "The import could not be completed."
          : "The import could not be completed.";
      setError(`${message} You can select the same file again to resume safely.`);
      setProgress("");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="import-panel" aria-labelledby="import-title">
      <div>
        <p className="eyebrow">START WITH YOUR ARCHIVE</p>
        <h2 id="import-title">Bring your bookmarks in.</h2>
        <p className="lede">Choose the JSON archive. It is checked in this browser and sent in small, retry-safe batches.</p>
      </div>
      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept=".json,application/json"
        disabled={busy}
        aria-label="Choose X bookmark archive JSON"
        onChange={(event) => void importFile(event.currentTarget.files?.[0])}
      />
      <button className="import-button" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Importing…" : "Choose JSON archive"}
      </button>
      <p className="import-limit">JSON files up to 25 MB. No archive content is written to browser storage.</p>
      {progress && <p className="import-message" role="status">{progress}</p>}
      {error && <p className="import-error" role="alert">{error}</p>}
      {summary && <dl className="import-summary" aria-label="Import results">
        <div><dt>Inserted</dt><dd>{summary.inserted}</dd></div>
        <div><dt>Enriched</dt><dd>{summary.enriched}</dd></div>
        <div><dt>Already saved</dt><dd>{summary.alreadyExisting}</dd></div>
        <div><dt>Duplicates in file</dt><dd>{summary.duplicateWithinFile}</dd></div>
        <div><dt>Invalid</dt><dd>{summary.invalid}</dd></div>
        <div><dt>Records checked</dt><dd>{summary.totalSeen}</dd></div>
      </dl>}
    </section>
  );
}
