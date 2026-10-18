import { SYNTHETIC_SEARCH_BOOKMARKS } from "./fixtures";
import type { EvaluationRequest, SearchEvaluator, SyntheticSearchBookmark } from "./types";

export const SYNTHETIC_BENCHMARK_SIZES = [1000, 10000, 50000] as const;
export type SyntheticBenchmarkSize = typeof SYNTHETIC_BENCHMARK_SIZES[number];

/** Generates exactly `size` synthetic records, preserving the evaluation corpus. */
export function* generateSyntheticBenchmarkRows(size: SyntheticBenchmarkSize): Generator<SyntheticSearchBookmark> {
  if (!(SYNTHETIC_BENCHMARK_SIZES as readonly number[]).includes(size)) {
    throw new Error("Supported benchmark sizes are 1000, 10000, and 50000.");
  }
  for (const row of SYNTHETIC_SEARCH_BOOKMARKS) {
    yield { ...row, tags: [...row.tags], collections: [...row.collections] };
  }
  const topics = ["plum orchard paths", "apricot pottery glaze", "willow basket weaving",
    "marble fountain courtyard", "cedar violin strings", "linen curtain fabric",
    "copper kettle handle", "saffron lentil stew"];
  for (let index = SYNTHETIC_SEARCH_BOOKMARKS.length + 1; index <= size; index++) {
    const tweetId = `9007199254741${String(index).padStart(6, "0")}`;
    yield {
      id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
      tweetId,
      canonicalUrl: `https://x.com/i/web/status/${tweetId}`,
      text: `Invented load record ${index}: ${topics[index % topics.length]}.`,
      authorUsername: `load_author_${index % 128}`,
      note: index % 4 === 0 ? `Invented annotation ${index}.` : "",
      tags: [`load_tag_${index % 32}`],
      collections: [`load_collection_${index % 16}`],
      tweetCreatedAt: `2025-06-${String(1 + index % 28).padStart(2, "0")}T12:00:00.000Z`,
      hasMedia: false,
      language: "en",
    };
  }
}

export const SYNTHETIC_BENCHMARK_REQUESTS: readonly EvaluationRequest[] = [
  { query: "9007199254740993001", limit: 10 },
  { query: '"transaction retry"', limit: 10 },
  { query: "compilers", limit: 10 },
  { query: "plum", limit: 10 },
  { query: "aprciot", limit: 10 },
  { query: "@load_author_7", limit: 10 },
  { query: "plum", filters: { tag: "load_tag_0" }, limit: 10 },
  { query: "xqzv_no_fixture_match_7291", limit: 10 },
];

export interface SearchBenchmarkResult {
  label: string;
  /** Caller-declared size; this helper does not inspect the target database. */
  declaredRowCount: SyntheticBenchmarkSize;
  warmupIterations: number;
  iterations: number;
  sampleCount: number;
  elapsedMs: number;
  perRequest: {
    requestIndex: number;
    sampleCount: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  }[];
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Serial first-page measurements. Warm-up samples are excluded from percentiles. */
export async function runSearchBenchmark(
  search: SearchEvaluator,
  options: {
    label: string;
    size: SyntheticBenchmarkSize;
    iterations?: number;
    warmupIterations?: number;
    requests?: readonly EvaluationRequest[];
  },
): Promise<SearchBenchmarkResult> {
  const iterations = options.iterations ?? 30;
  const warmupIterations = options.warmupIterations ?? 3;
  const requests = options.requests ?? SYNTHETIC_BENCHMARK_REQUESTS;
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1000) {
    throw new Error("iterations must be an integer from 1 to 1000.");
  }
  if (!Number.isSafeInteger(warmupIterations) || warmupIterations < 0 || warmupIterations > 100) {
    throw new Error("warmupIterations must be an integer from 0 to 100.");
  }
  if (!(SYNTHETIC_BENCHMARK_SIZES as readonly number[]).includes(options.size)) {
    throw new Error("Unsupported synthetic benchmark size.");
  }
  if (requests.length === 0) throw new Error("At least one benchmark request is required.");
  const started = performance.now();
  for (let iteration = 0; iteration < warmupIterations; iteration++) {
    for (const request of requests) await search(request);
  }
  const samples = requests.map(() => [] as number[]);
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let index = 0; index < requests.length; index++) {
      const requestStarted = performance.now();
      await search(requests[index]);
      samples[index].push(performance.now() - requestStarted);
    }
  }
  return {
    label: options.label,
    declaredRowCount: options.size,
    warmupIterations,
    iterations,
    sampleCount: requests.length * iterations,
    elapsedMs: performance.now() - started,
    perRequest: samples.map((values, requestIndex) => ({
      requestIndex,
      sampleCount: values.length,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      maxMs: Math.max(...values),
    })),
  };
}
