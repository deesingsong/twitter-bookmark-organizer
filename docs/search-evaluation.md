# Synthetic search evaluation

The evaluation kit in `src/lib/search/evaluation/` contains 24 invented bookmarks,
40 query cases, a callback evaluator, and deterministic 1k/10k/50k data generation.
It contains no owner archive content, production credentials, or embeddings.
These are search fixtures, independent of any archive adapter or HTTP endpoint.

The kit's own tests verify evaluation arithmetic and failure detection. They do
not establish database search quality or database performance by themselves;
the development-database run and its limits are recorded below.

## Development Neon run (2026-10-17)

The full 40-case synthetic evaluation passed against the local app and the
development-only `bookmark_dev` database on PostgreSQL 17.11 with pg_trgm 1.6.
The database held the 24 invented evaluation records during the run; test rows,
tags, and collections were removed afterward and the database was verified empty.
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` was captured for exact-ID, FTS, and
fuzzy predicates on that small corpus. PostgreSQL chose sequential scans for
exact-ID and FTS (about 0.04 ms each in that sample) and a `Limit` root for the
fuzzy path (about 0.33 ms). The tiny relation makes those plans unsuitable for
judging index use or scale.

On the same 26 no-filter, non-pagination judgments, the lexical implementation
measured Recall@10 **1.0000** and MRR@10 **0.9792**. The legacy ILIKE baseline
measured Recall@10 **0.2569** and MRR@10 **0.3750**. The baseline searches only
the old tweet text, author fields, and quoted text with substring ILIKE. These
are small synthetic-corpus results, not a prediction of performance or quality
on the owner's archive.

The HTTP API benchmark then ran serially at exactly 1k, 10k, and 50k synthetic
rows, with one warmup and three measured samples for each of eight requests per
size. At 50k, the broad `plum` full-text query measured about 1.85 s p50 / 1.87 s
p95, while the same query filtered by a tag measured about 0.26 s p50 / 0.29 s
p95. The other 50k workload p95 values ranged from about 0.15 to 0.25 s. These are
local Playwright client-to-Next-to-Neon timings, not isolated database latency.
The broad common-term query is a known scale limitation: it was slower than the
planned 250 ms FTS target, though it completed within the 3-second statement
timeout. No performance claim is made beyond this synthetic workload and
environment.

## Direct evaluator contract

Seed `SYNTHETIC_SEARCH_BOOKMARKS` into an explicitly selected, disposable test
database through a caller-owned adapter. Preserve bookmark IDs, string tweet IDs,
annotations, tags, collections, and null dates/text. Leave production data out of
this evaluation. The evaluator itself performs no database setup or writes.

Pass `runSearchEvaluation` a `SearchEvaluator` callback:

```ts
type SearchEvaluator = (request: {
  query: string;
  filters?: {
    author?: string;
    tag?: string;
    collection?: string;
    from?: string; // inclusive UTC instant, applied to tweetCreatedAt
    to?: string;   // inclusive UTC instant, applied to tweetCreatedAt
  };
  limit: number;
  cursor?: string;
}) => Promise<{
  hits: readonly { id: string }[];
  nextCursor: string | null;
}>;
```

For a target returning `{ bookmarks, nextCursor }`, map each bookmark to `{ id }`
and pass its cursor through unchanged. Map request names at the same boundary.
The callback can call the direct search function or an existing server adapter;
no new endpoint is needed. Do not implement a second search algorithm inside the
adapter. Dates in this contract are UTC instants; preserve that meaning when the
target uses date-only inputs or a different date-range convention.

```ts
import {
  runSearchEvaluation,
  type SearchEvaluator,
} from "@/lib/search/evaluation";

// `search` is supplied by the caller after seeding the synthetic snapshot.
async function evaluateSyntheticSnapshot(search: SearchEvaluator) {
  const report = await runSearchEvaluation(search);
  if (!report.passed) {
    throw new Error("Synthetic search invariants failed; inspect report.results.");
  }
  return report;
}
```

## Judgments and checks

| Cases | What they check |
| --- | --- |
| Exact IDs and domain variants | String precision, URL normalization, and exact identity ahead of a textual ID mention |
| Handles, phrases, technical strings | Author identity, case handling, phrase adjacency, punctuation, and underscores |
| Literal, stemmed, and misspelled compiler posts | Literal before FTS before fuzzy; exact typo text still wins its own query |
| Notes and tags | Owner annotations participate in retrieval |
| Author/tag/collection/date combinations | Filter intersection and no filter leakage in exact, literal, or fuzzy paths |
| Equal-date pagination posts | Stable repeats, opaque cursor traversal, completeness, no duplicates, and identical order across page sizes |
| Missing text and non-English text | No invented searchable content; a French literal can be found without a promise about English stemming |

Each query is executed twice against an unchanged snapshot. Precedence pairs
require both candidates in the top ten. This deliberately tests tier order;
within-tier order is unconstrained as long as repeated searches and cursor
traversal agree. Three cases traverse cursors with page sizes one or two; the
default maximum is 100 pages, and repeated cursors or empty intermediate pages
fail. The target must apply filters before pagination.

`relevantIds` are hand-labeled judgments; unlisted results are unjudged. They
are separate from `requiredIds`, `firstId`, `before`, `excludedIds`, and `empty`,
which define pass/fail invariants. A low recall score does not implicitly pass
or fail a quality threshold. Review the scores and failed cases explicitly.

Recall@10 is the number of unique judged relevant IDs in the first ten hits
divided by the query's judged relevant count. Reciprocal rank@10 is the inverse
rank of the first judged relevant hit, or zero if none appears in the first ten.
The report averages each metric over queries with at least one judged relevant
document; zero-relevance cases still check their explicit empty/filter rules.
Queries with callback failures carry a failure issue. Raw adapter exceptions
are omitted from the report to avoid copying driver diagnostics.

For later lexical/semantic/hybrid comparison, seed the same snapshot, use the
same judgments, and supply a callback for each mode. Preserve exact and filter
requirements. Any judgment change requires review before comparing runs. This
suite supplies no vectors and makes no semantic quality claim.

## Reproducible database benchmark

1. Select an isolated test database and record the commit, migrations, PostgreSQL
   version, extensions, index definitions, region, compute size, and connection
   mode. Record the executing machine and its network location. Never select the
   personal archive or production credentials for this procedure.
2. For each size in `SYNTHETIC_BENCHMARK_SIZES`, seed exactly the rows from
   `generateSyntheticBenchmarkRows(size)` in bounded batches. This generator
   preserves the 24 judgment records and emits only invented filler. Confirm
   the persisted row count independently; `declaredRowCount` in the report is
   supplied by the caller and is not proof of the database's actual size.
3. Measure seeding duration, peak process memory, request/batch sizes, persisted
   table/index storage, and resource use. Update planner statistics through the
   normal test setup. Run `runSearchEvaluation` before timing retrieval.
4. Supply the direct search callback to `runSearchBenchmark(search, { label,
   size })`. The default workload has eight first-page requests, three excluded
   warmup iterations, and 30 measured iterations per request. Calls run serially
   and round-robin. Queries cover exact identity, phrase, FTS/fuzzy, a common
   filler word, filtered filler, handle, and zero results. The helper returns
   p50, p95, and maximum callback wall time for each request; its overall elapsed
   time includes warmups. It does not measure import performance.
5. Capture execution plans and buffer/row-count observations for representative
   slow queries using the target's existing parameterized query path. Record
   cold-start observations separately from warm runs. If measuring HTTP or a
   remote function, label network/function overhead separately from database
   execution time. Cursor traversal latency needs a separate measured run.
6. Repeat a complete run after any query or index change. Record results below,
   together with query mix, actual row count, sample counts, failures, and the
   environment details. Agree on acceptable latency only after measurement.
   Synthetic distribution and warm serial queries cannot prove private-archive
   performance, concurrency capacity, or free-tier suitability.

| Rows | Actual persisted count | Seed time / peak memory | Storage | Retrieval p50 / p95 by request | Status |
| --- | --- | --- | --- | --- | --- |
| 1,000 | Not measured | Not measured | Not measured | Not measured | Pending database run |
| 10,000 | Not measured | Not measured | Not measured | Not measured | Pending database run |
| 50,000 | Not measured | Not measured | Not measured | Not measured | Pending database run |

Run the focused harness checks with:

```sh
npm test -- src/lib/search/evaluation/evaluation.test.ts
```
