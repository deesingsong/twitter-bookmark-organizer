import { Pool } from "@neondatabase/serverless";
import { expect, test, type Page } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { generateSyntheticBenchmarkRows, runSearchBenchmark, runSearchEvaluation, SYNTHETIC_BENCHMARK_REQUESTS, SYNTHETIC_BENCHMARK_SIZES, SYNTHETIC_SEARCH_BOOKMARKS, SYNTHETIC_SEARCH_CASES } from "../src/lib/search/evaluation";
import type { EvaluationFilters, SearchBenchmarkResult, SyntheticBenchmarkSize } from "../src/lib/search/evaluation";
import { requireLocalE2ETarget } from "./local-target";

loadEnv({ path: ".env.local" });
const BOOKMARK_IDS = SYNTHETIC_SEARCH_BOOKMARKS.map((item) => item.id);
const TAG_PREFIX = "search-e2e-";
const COLLECTION_PREFIX = "search-e2e-";
let pool: Pool | undefined;
const tagIds = new Map<string, string>();
const collectionIds = new Map<string, string>();

function databasePool(): Pool {
  if (pool) return pool;
  const target = requireLocalE2ETarget();
  pool = new Pool({ connectionString: target.directConnectionString, max: 1 });
  return pool;
}

async function cleanup() {
  const db = databasePool();
  await db.query("delete from bookmarks where id = any($1::uuid[])", [BOOKMARK_IDS]);
  await db.query("delete from tags where name like $1", [`${TAG_PREFIX}%`]);
  await db.query("delete from collections where name like $1", [`${COLLECTION_PREFIX}%`]);
  tagIds.clear();
  collectionIds.clear();
}

async function seed() {
  const db = databasePool();
  await cleanup();
  for (const item of SYNTHETIC_SEARCH_BOOKMARKS) {
    const quote = item.id === SYNTHETIC_SEARCH_BOOKMARKS[14].id ? { text: "QuotedOnlyNeedle appears only in this invented quoted post." } : null;
    await db.query(`insert into bookmarks
      (id,tweet_id,canonical_url,text,author_username,author_display_name,quoted_tweet,note,language,tweet_created_at,has_media,source_metadata)
      values ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,'{"source":"synthetic-search-e2e"}'::jsonb)`,
    [item.id, item.tweetId, item.canonicalUrl, item.text, item.authorUsername, quote, item.note, item.language, item.tweetCreatedAt, item.hasMedia]);
  }
  for (const name of new Set(SYNTHETIC_SEARCH_BOOKMARKS.flatMap((item) => item.tags))) {
    const inserted = await db.query<{ id: string }>("insert into tags(name) values($1) returning id", [`${TAG_PREFIX}${name}`]);
    tagIds.set(name, inserted.rows[0].id);
  }
  for (const name of new Set(SYNTHETIC_SEARCH_BOOKMARKS.flatMap((item) => item.collections))) {
    const inserted = await db.query<{ id: string }>("insert into collections(name) values($1) returning id", [`${COLLECTION_PREFIX}${name}`]);
    collectionIds.set(name, inserted.rows[0].id);
  }
  for (const item of SYNTHETIC_SEARCH_BOOKMARKS) {
    for (const name of item.tags) await db.query("insert into bookmark_tags(bookmark_id,tag_id) values($1,$2)", [item.id, tagIds.get(name)]);
    for (const name of item.collections) await db.query("insert into collection_bookmarks(bookmark_id,collection_id) values($1,$2)", [item.id, collectionIds.get(name)]);
  }
}

function makeEvaluator(page: Page) {
  return async ({ query, filters, limit, cursor }: { query: string; filters?: EvaluationFilters; limit: number; cursor?: string }) => {
    const params = new URLSearchParams({ q: query, limit: String(limit), sort: "relevance" });
    if (cursor) params.set("cursor", cursor);
    if (filters?.author) params.set("author", filters.author);
    if (filters?.from) params.set("from", filters.from.slice(0, 10));
    if (filters?.to) params.set("to", filters.to.slice(0, 10));
    if (filters?.tag) params.set("tag", tagIds.get(filters.tag) ?? "missing");
    if (filters?.collection) params.set("collection", collectionIds.get(filters.collection) ?? "missing");
    const response = await page.request.get(`/api/bookmarks?${params}`);
    if (!response.ok()) throw new Error("Search API returned an error status.");
    const body = await response.json() as { bookmarks: { id: string }[]; nextCursor: string | null };
    return { hits: body.bookmarks.map(({ id }) => ({ id })), nextCursor: body.nextCursor };
  };
}

async function runIlikeBaseline(query: string, limit: number) {
  const pattern = `%${query}%`;
  const result = await databasePool().query<{ id: string }>(`select id from bookmarks
    where id = any($1::uuid[]) and (text ilike $2 or author_username ilike $2 or author_display_name ilike $2
      or coalesce(quoted_tweet->>'text','') ilike $2)
    order by coalesce(tweet_created_at, first_imported_at) desc, id desc limit $3`, [BOOKMARK_IDS, pattern, limit]);
  return { hits: result.rows, nextCursor: null };
}

test.describe("lexical bookmark search", () => {
  test.beforeAll(async () => seed());
  test.afterAll(async () => {
    if (!pool) return;
    try { await clearBenchmarkRows(); await cleanup(); } finally { await pool.end(); pool = undefined; }
  });

  test("meets synthetic exact, lexical, filter, and cursor evaluation cases", async ({ page }) => {
    const report = await runSearchEvaluation(makeEvaluator(page), { repeatCount: 2 });
    const failures = report.results.filter((result) => result.issues.length > 0).map((result) => ({ id: result.caseId, issues: result.issues, ids: result.retrievedIds }));
    expect(failures, JSON.stringify(failures)).toEqual([]);
    expect(report.meanRecallAt10).toBeGreaterThanOrEqual(0.9);
    expect(report.meanReciprocalRankAt10).toBeGreaterThanOrEqual(0.85);
  });

  test("compares the old ILIKE baseline on identical synthetic lexical judgments", async ({ page }) => {
    const cases = SYNTHETIC_SEARCH_CASES.filter((item) => !item.pagination && !item.filters);
    const [lexical, baseline] = await Promise.all([
      runSearchEvaluation(makeEvaluator(page), { cases }),
      runSearchEvaluation(async ({ query, limit }) => runIlikeBaseline(query, limit), { cases }),
    ]);
    console.info("Synthetic lexical evaluation", JSON.stringify({
      queries: lexical.queryCount,
      lexical: { recallAt10: lexical.meanRecallAt10, mrrAt10: lexical.meanReciprocalRankAt10 },
      priorIlike: { recallAt10: baseline.meanRecallAt10, mrrAt10: baseline.meanReciprocalRankAt10 },
    }));
    expect(lexical.meanRecallAt10).toBeGreaterThanOrEqual(0.9);
    expect(lexical.meanReciprocalRankAt10).toBeGreaterThanOrEqual(0.85);
  });

  test("keeps the search document current after note and tag changes and indexes quoted text", async ({ page }) => {
    const noteId = SYNTHETIC_SEARCH_BOOKMARKS[11].id;
    const tagId = SYNTHETIC_SEARCH_BOOKMARKS[12].id;
    const quoteId = SYNTHETIC_SEARCH_BOOKMARKS[14].id;
    const db = databasePool();
    await db.query("update bookmarks set note=$1 where id=$2", ["Cobalthex note refreshed after edit.", noteId]);
    await expectApiIds(page, "cobalthex", [noteId]);
    await expectApiIds(page, "amberneedle", []);
    const currentTagId = tagIds.get("zirconlabel");
    if (!currentTagId) throw new Error("Expected synthetic tag fixture was not seeded.");
    await db.query("update tags set name=$1 where id=$2", [`${TAG_PREFIX}cobalthex_tag`, currentTagId]);
    await expectApiIds(page, "cobalthex_tag", [tagId]);
    await db.query("delete from bookmark_tags where bookmark_id=$1 and tag_id=$2", [tagId, currentTagId]);
    await expectApiIds(page, "cobalthex_tag", []);
    await expectApiIds(page, "QuotedOnlyNeedle", [quoteId]);
  });

  test("captures development query plans for exact, full-text, and fuzzy paths", async () => {
    const db = databasePool();
    await db.query("analyze bookmarks");
    await db.query("select set_config('pg_trgm.word_similarity_threshold','0.55',false)");
    const statements = [
      ["exact-id", "select id from bookmarks where tweet_id=$1", [SYNTHETIC_SEARCH_BOOKMARKS[0].tweetId]],
      ["full-text", "select id from bookmarks where search_document @@ websearch_to_tsquery('english',$1)", ["compiler"]],
      ["fuzzy", "select id from bookmarks where $1 <% search_text order by word_similarity($1,search_text) desc limit 200", ["compilres"]],
    ] as const;
    const plans = [];
    for (const [name, query, values] of statements) {
      const result = await db.query<{ "QUERY PLAN": { "Plan": { "Node Type": string }; "Execution Time": number }[] }>(`explain (analyze,buffers,format json) ${query}`, [...values]);
      const plan = result.rows[0]["QUERY PLAN"][0];
      plans.push({ name, node: plan.Plan["Node Type"], executionMs: plan["Execution Time"] });
    }
    console.info("Synthetic bookmark query plans", JSON.stringify(plans));
    expect(plans).toHaveLength(3);
    expect(plans.every((plan) => Number.isFinite(plan.executionMs))).toBe(true);
  });

  test("measures synthetic API latency at 1k, 10k, and 50k rows", async ({ page }) => {
    test.setTimeout(300_000);
    const reports: SearchBenchmarkResult[] = [];
    for (const size of SYNTHETIC_BENCHMARK_SIZES) {
      await seedBenchmarkRows(size);
      reports.push(await runSearchBenchmark(makeEvaluator(page), {
        label: `development-api-${size}`, size, iterations: 3, warmupIterations: 1, requests: SYNTHETIC_BENCHMARK_REQUESTS,
      }));
    }
    console.info("Synthetic search API benchmark", JSON.stringify(reports.map((report) => ({
      rows: report.declaredRowCount,
      requests: report.perRequest.map((sample) => ({ index: sample.requestIndex, p50Ms: sample.p50Ms, p95Ms: sample.p95Ms, maxMs: sample.maxMs })),
    }))));
    expect(reports.map((report) => report.declaredRowCount)).toEqual([1000, 10000, 50000]);
    expect(reports.every((report) => report.perRequest.length === SYNTHETIC_BENCHMARK_REQUESTS.length)).toBe(true);
  });

  test("updates results while typing and keeps the search controls usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const search = page.getByRole("textbox", { name: "Search posts" });
    await search.fill('"transaction retry"');
    await expect(page.getByText("A transaction retry should preserve the original request identity.")).toBeVisible();
    await expect(page.getByText("literal", { exact: true }).first()).toBeVisible();
    const layout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(layout.scroll).toBeLessThanOrEqual(layout.viewport);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(search).toBeVisible();
    const desktopLayout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(desktopLayout.scroll).toBeLessThanOrEqual(desktopLayout.viewport);
  });

  test("shows a clear server error when the library request fails", async ({ page }) => {
    await page.route("**/api/bookmarks?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"library_unavailable"}' }));
    await page.goto("/");
    await expect(page.getByRole("alert").getByText("The library could not be loaded. Try again.")).toBeVisible();
  });
});

async function expectApiIds(page: Page, query: string, expectedIds: string[]) {
  const params = new URLSearchParams({ q: query, limit: "20", sort: "relevance" });
  const response = await page.request.get(`/api/bookmarks?${params}`);
  expect(response.ok()).toBe(true);
  const body = await response.json() as { bookmarks: { id: string }[] };
  expect(body.bookmarks.map((item) => item.id)).toEqual(expectedIds);
}

async function clearBenchmarkRows() {
  const db = databasePool();
  await db.query("delete from bookmarks where id::text like '00000000-0000-4000-8001-%'");
  await db.query("delete from tags where name like 'search-e2e-load-%'");
  await db.query("delete from collections where name like 'search-e2e-load-%'");
}

async function seedBenchmarkRows(size: SyntheticBenchmarkSize) {
  const db = databasePool();
  await clearBenchmarkRows();
  const generated = [...generateSyntheticBenchmarkRows(size)].filter((row) => row.id.startsWith("00000000-0000-4000-8001-"));
  const tagNames = Array.from({ length: 32 }, (_, index) => `load_tag_${index}`);
  const collectionNames = Array.from({ length: 16 }, (_, index) => `load_collection_${index}`);
  for (const name of tagNames) await db.query("insert into tags(name) values($1) on conflict(name) do nothing", [`${TAG_PREFIX}${name}`]);
  for (const name of collectionNames) await db.query("insert into collections(name) values($1) on conflict(name) do nothing", [`${COLLECTION_PREFIX}${name}`]);
  for (const name of tagNames) {
    const result = await db.query<{ id: string }>("select id from tags where name=$1", [`${TAG_PREFIX}${name}`]);
    tagIds.set(name, result.rows[0].id);
  }
  for (let offset = 0; offset < generated.length; offset += 500) {
    const batch = generated.slice(offset, offset + 500);
    const bookmarks = batch.map((row) => ({ id: row.id, tweet_id: row.tweetId, canonical_url: row.canonicalUrl, text: row.text,
      author_username: row.authorUsername, note: row.note, language: row.language, tweet_created_at: row.tweetCreatedAt,
      has_media: row.hasMedia, source_metadata: { source: "synthetic-search-benchmark" } }));
    await db.query(`insert into bookmarks(id,tweet_id,canonical_url,text,author_username,note,language,tweet_created_at,has_media,source_metadata)
      select r.id,r.tweet_id,r.canonical_url,r.text,r.author_username,r.note,r.language,r.tweet_created_at,r.has_media,r.source_metadata
      from jsonb_to_recordset($1::jsonb) as r(id uuid,tweet_id text,canonical_url text,text text,author_username text,note text,language text,tweet_created_at timestamptz,has_media boolean,source_metadata jsonb)`, [JSON.stringify(bookmarks)]);
    await db.query(`insert into bookmark_tags(bookmark_id,tag_id)
      select r.bookmark_id,t.id from jsonb_to_recordset($1::jsonb) as r(bookmark_id uuid,tags jsonb)
      cross join lateral jsonb_array_elements_text(r.tags) as tag_name(name)
      join tags t on t.name='${TAG_PREFIX}'||tag_name.name`, [JSON.stringify(batch.map((row) => ({ bookmark_id: row.id, tags: row.tags })))]);
    await db.query(`insert into collection_bookmarks(bookmark_id,collection_id)
      select r.bookmark_id,c.id from jsonb_to_recordset($1::jsonb) as r(bookmark_id uuid,collections jsonb)
      cross join lateral jsonb_array_elements_text(r.collections) as collection_name(name)
      join collections c on c.name='${COLLECTION_PREFIX}'||collection_name.name`, [JSON.stringify(batch.map((row) => ({ bookmark_id: row.id, collections: row.collections })))]);
  }
  await db.query("analyze bookmarks");
  const count = await db.query<{ count: number }>("select count(*)::int as count from bookmarks");
  if (count.rows[0].count !== size) throw new Error("Benchmark database count does not match its requested synthetic size.");
}
