import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Pool } from "@neondatabase/serverless";
import { expect, test, type Page } from "@playwright/test";
import { requireLocalE2ETarget } from "./local-target";

loadEnv({ path: ".env.local" });

const archivePath = path.join(process.cwd(), "src/lib/import/fixtures/twitter-bookmarks-v1.synthetic.json");
const archiveBytes = readFileSync(archivePath);
const archiveFileHash = createHash("sha256").update(archiveBytes).digest("hex");
const rollbackFileHash = createHash("sha256").update("synthetic transactional retry fixture").digest("hex");
const tweetIds = ["9007199254740993", "9007199254740994", "9007199254740988", "9007199254740995", "9007199254740996", "9007199254740997"];
const tagName = "e2e-synthetic-tag";
const collectionName = "e2e-synthetic-collection";
const sourceFormat = "twitter-bookmarks/v1";

let pool: Pool | undefined;
const jobIds: string[] = [];

function databasePool(): Pool {
  if (pool) return pool;
  const target = requireLocalE2ETarget();
  pool = new Pool({ connectionString: target.directConnectionString, max: 1 });
  return pool;
}

function normalizedRecord(id: string, text: string) {
  return {
    tweetId: id,
    canonicalUrl: `https://x.com/i/web/status/${id}`,
    originalUrl: null,
    text,
    authorId: null,
    authorUsername: null,
    authorDisplayName: null,
    authorAvatarUrl: null,
    authorVerified: null,
    language: null,
    tweetCreatedAt: null,
    bookmarkedAt: null,
    lastSeenAt: null,
    sourceMetrics: null,
    mediaReferences: [],
    quotedTweet: null,
    sourceMetadata: { schemaVersion: 1, source: "synthetic-e2e" },
    hasMedia: false,
  };
}

async function cleanTestData() {
  const db = databasePool();
  await db.query("DELETE FROM bookmarks WHERE tweet_id = ANY($1::text[])", [tweetIds]);
  await db.query(
    "DELETE FROM import_jobs WHERE source_format = $1 AND source_file_hash = ANY($2::text[])",
    [sourceFormat, [archiveFileHash, rollbackFileHash]],
  );
  await db.query("DELETE FROM tags WHERE name = $1", [tagName]);
  await db.query("DELETE FROM collections WHERE name = $1", [collectionName]);
  jobIds.length = 0;
}

async function uploadSyntheticArchive(page: Page) {
  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/imports",
  );
  await page.getByLabel("Choose X bookmark archive JSON").setInputFiles(archivePath);
  const response = await createResponse;
  expect(response.ok()).toBeTruthy();
  const data = await response.json() as { job: { id: string } };
  jobIds.push(data.job.id);
  await expect(page.locator(".import-message")).toHaveText("Import complete.", { timeout: 30_000 });
}

async function postJsonInBrowser(page: Page, url: string, data: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as unknown };
  }, { path: url, body: data });
}

test("synthetic imports are transactional, retry-safe, and preserve or cascade database state correctly", async ({ page }) => {
  const db = databasePool();
  const identity = await db.query<{ database_name: string; vector_version: string | null }>(
    "SELECT current_database() AS database_name, (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version",
  );
  expect(identity.rows[0].database_name).toBe("bookmark_dev");
  expect(identity.rows[0].vector_version).toBeTruthy();
  await cleanTestData();

  await page.goto("/");
  const create = await postJsonInBrowser(page, "/api/imports", {
      sourceFormat,
      fileHash: rollbackFileHash,
      totalSeen: 2,
      expectedBatches: 1,
      duplicateWithinFile: 0,
      invalid: 0,
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const createdJob = create.body as { job: { id: string } };
  jobIds.push(createdJob.job.id);

  const conflictId = tweetIds[2];
  const incomingId = tweetIds[0];
  await db.query(
    "INSERT INTO bookmarks (tweet_id, canonical_url, text) VALUES ($1, $2, $3)",
    [conflictId, `https://x.com/i/web/status/${incomingId}`, "synthetic uniqueness conflict"],
  );
  const records = [
    normalizedRecord(tweetIds[1], "synthetic first record, should roll back"),
    normalizedRecord(incomingId, "synthetic conflicting record"),
  ];
  const batchUrl = `/api/imports/${createdJob.job.id}/batches`;
  const failedBatch = await postJsonInBrowser(page, batchUrl, { batchNumber: 0, records });
  expect(failedBatch.status).toBe(409);
  expect((failedBatch.body as { error: string }).error).toBe("bookmark_identity_conflict");
  const rolledBack = await db.query("SELECT count(*)::int AS count FROM bookmarks WHERE tweet_id = $1", [tweetIds[1]]);
  expect(rolledBack.rows[0].count).toBe(0);
  await db.query("DELETE FROM bookmarks WHERE tweet_id = $1", [conflictId]);

  const retry = await postJsonInBrowser(page, batchUrl, { batchNumber: 0, records });
  expect(retry.status).toBe(200);
  const retryBody = retry.body as { job: { status: string; inserted: number } };
  expect(retryBody.job.status).toBe("completed");
  expect(retryBody.job.inserted).toBe(2);

  const replay = await postJsonInBrowser(page, batchUrl, { batchNumber: 0, records });
  expect(replay.status).toBe(200);
  expect((replay.body as { batch: { replayed: boolean } }).batch.replayed).toBe(true);
  const changedReplay = await postJsonInBrowser(page, batchUrl, {
    batchNumber: 0,
    records: [records[0], normalizedRecord(incomingId, "different synthetic payload")],
  });
  expect(changedReplay.status).toBe(409);
  expect((changedReplay.body as { error: string }).error).toBe("batch_replay_conflict");
  await cleanTestData();

  await uploadSyntheticArchive(page);
  const summary = page.locator(".import-summary");
  await expect(summary.locator("div").filter({ hasText: "Inserted" }).locator("dd")).toHaveText("2");
  await expect(summary.locator("div").filter({ hasText: "Duplicates in file" }).locator("dd")).toHaveText("1");
  await expect(summary.locator("div").filter({ hasText: "Invalid" }).locator("dd")).toHaveText("1");

  const bookmarkId = tweetIds[0];
  const bookmark = await db.query<{ id: string }>("SELECT id FROM bookmarks WHERE tweet_id = $1", [bookmarkId]);
  expect(bookmark.rows).toHaveLength(1);
  const rowId = bookmark.rows[0].id;
  await db.query("UPDATE bookmarks SET note = $1 WHERE id = $2", ["synthetic owner note", rowId]);
  const tag = await db.query<{ id: string }>("INSERT INTO tags (name) VALUES ($1) RETURNING id", [tagName]);
  const collection = await db.query<{ id: string }>("INSERT INTO collections (name) VALUES ($1) RETURNING id", [collectionName]);
  await db.query("INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES ($1, $2)", [rowId, tag.rows[0].id]);
  await db.query("INSERT INTO collection_bookmarks (bookmark_id, collection_id) VALUES ($1, $2)", [rowId, collection.rows[0].id]);
  const vector = `[${Array(384).fill(0).join(",")}]`;
  await db.query(
    "INSERT INTO bookmark_embeddings (bookmark_id, embedding, model_id, model_revision, content_hash, status, indexed_at) VALUES ($1, $2::vector, $3, $4, $5, 'ready', now())",
    [rowId, vector, "synthetic-model", "synthetic-revision", "0".repeat(64)],
  );

  await uploadSyntheticArchive(page);
  await expect(page.locator(".import-summary div").filter({ hasText: "Already saved" }).locator("dd")).toHaveText("2");
  const preserved = await db.query<{ note: string; tags: number; collections: number; embeddings: number }>(
    `SELECT b.note,
      (SELECT count(*)::int FROM bookmark_tags WHERE bookmark_id = b.id) AS tags,
      (SELECT count(*)::int FROM collection_bookmarks WHERE bookmark_id = b.id) AS collections,
      (SELECT count(*)::int FROM bookmark_embeddings WHERE bookmark_id = b.id) AS embeddings
     FROM bookmarks b WHERE b.id = $1`,
    [rowId],
  );
  expect(preserved.rows[0]).toEqual({ note: "synthetic owner note", tags: 1, collections: 1, embeddings: 1 });

  await db.query("DELETE FROM bookmarks WHERE id = $1", [rowId]);
  const cascaded = await db.query<{ tags: number; collections: number; embeddings: number; retained_tag: number; retained_collection: number }>(
    `SELECT
      (SELECT count(*)::int FROM bookmark_tags WHERE bookmark_id = $1) AS tags,
      (SELECT count(*)::int FROM collection_bookmarks WHERE bookmark_id = $1) AS collections,
      (SELECT count(*)::int FROM bookmark_embeddings WHERE bookmark_id = $1) AS embeddings,
      (SELECT count(*)::int FROM tags WHERE id = $2) AS retained_tag,
      (SELECT count(*)::int FROM collections WHERE id = $3) AS retained_collection`,
    [rowId, tag.rows[0].id, collection.rows[0].id],
  );
  expect(cascaded.rows[0]).toEqual({ tags: 0, collections: 0, embeddings: 0, retained_tag: 1, retained_collection: 1 });

  await uploadSyntheticArchive(page);
  await expect(page.locator(".import-summary div").filter({ hasText: "Inserted" }).locator("dd")).toHaveText("1");
  const reimported = await db.query("SELECT count(*)::int AS count FROM bookmarks WHERE tweet_id = $1", [bookmarkId]);
  expect(reimported.rows[0].count).toBe(1);
  await cleanTestData();
});

test("the import screen fits a phone viewport and reports a server error without losing the retry path", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/imports", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "database_unavailable" }),
  }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bring your bookmarks in." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose JSON archive" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

  await page.getByLabel("Choose X bookmark archive JSON").setInputFiles(archivePath);
  await expect(page.locator(".import-error")).toContainText("temporarily unavailable");
  await expect(page.getByRole("button", { name: "Choose JSON archive" })).toBeEnabled();
});

test("bookmark library filters, paginates, manages annotations, and confirms deletion", async ({ page }) => {
  const db = databasePool();
  await cleanTestData();
  const now = Date.now();
  const seeds = [
    { id: tweetIds[3], text: "Synthetic library newest post", created: new Date(now).toISOString(), quote: { text: "A synthetic quoted post", authorUsername: "quoted_user", canonicalUrl: "https://x.com/quoted_user/status/123456789" }, media: [{ type: "image", url: "https://example.test/synthetic.jpg" }] },
    { id: tweetIds[4], text: "Synthetic library middle post", created: new Date(now - 86_400_000).toISOString(), quote: null, media: [] },
    { id: tweetIds[5], text: "Synthetic library oldest post", created: new Date(now - 172_800_000).toISOString(), quote: null, media: [] },
  ];
  for (const seed of seeds) await db.query(
    "INSERT INTO bookmarks (tweet_id, canonical_url, text, author_username, author_display_name, tweet_created_at, quoted_tweet, media_references, has_media) VALUES ($1,$2,$3,'synthetic_author','Synthetic Author',$4,$5::jsonb,$6::jsonb,$7)",
    [seed.id, `https://x.com/i/web/status/${seed.id}`, seed.text, seed.created, JSON.stringify(seed.quote), JSON.stringify(seed.media), seed.media.length > 0],
  );
  const managementBookmark = await db.query<{ id: string }>("SELECT id FROM bookmarks WHERE tweet_id=$1", [tweetIds[3]]);
  const managementId = managementBookmark.rows[0].id;

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The library" })).toBeVisible();
  await expect(page.getByText("Synthetic library newest post")).toBeVisible();
  await expect(page.getByText("A synthetic quoted post")).toBeVisible();
  await expect(page.getByText("Open media reference ↗")).toBeVisible();

  const pageOne = await page.evaluate(async () => (await fetch("/api/bookmarks?limit=2")).json() as Promise<{ bookmarks: { tweetId: string }[]; nextCursor: string }>);
  expect(pageOne.bookmarks.map(x => x.tweetId)).toEqual([tweetIds[3], tweetIds[4]]);
  const pageTwo = await page.evaluate(async (cursor) => (await fetch(`/api/bookmarks?limit=2&cursor=${encodeURIComponent(cursor)}`)).json() as Promise<{ bookmarks: { tweetId: string }[] }>, pageOne.nextCursor);
  expect(pageTwo.bookmarks[0].tweetId).toBe(tweetIds[5]);

  const create = await page.evaluate(async () => {
    const tag = await fetch("/api/organize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "tag", name: "e2e-synthetic-tag" }) });
    const collection = await fetch("/api/organize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "collection", name: "e2e-synthetic-collection", description: "synthetic" }) });
    return { tag: await tag.json() as { item: { id: string } }, collection: await collection.json() as { item: { id: string } } };
  });
  expect(create.tag.item.id).toBeTruthy();
  expect(create.collection.item.id).toBeTruthy();
  await page.getByRole("button", { name: "Details" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Personal note").fill("A synthetic owner note");
  await page.route(`**/api/bookmarks/${managementId}`, route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "note_save_failed" }) })
    : route.continue());
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.locator(".library-error")).toContainText("could not be saved");
  await page.unroute(`**/api/bookmarks/${managementId}`);
  expect((await db.query<{ note: string | null }>("SELECT note FROM bookmarks WHERE id=$1", [managementId])).rows[0].note).toBeNull();
  await page.getByLabel("Personal note").fill("A synthetic owner note");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Note saved." })).toBeVisible();
  await page.getByLabel("e2e-synthetic-tag").click();
  await expect.poll(async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM bookmark_tags bt JOIN tags t ON t.id=bt.tag_id JOIN bookmarks b ON b.id=bt.bookmark_id WHERE b.tweet_id=$1 AND t.name=$2", [tweetIds[3], tagName])).rows[0].n).toBe(1);
  await page.getByLabel("e2e-synthetic-collection").click();
  await expect.poll(async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM collection_bookmarks cb JOIN collections c ON c.id=cb.collection_id JOIN bookmarks b ON b.id=cb.bookmark_id WHERE b.tweet_id=$1 AND c.name=$2", [tweetIds[3], collectionName])).rows[0].n).toBe(1);
  await expect.poll(async () => (await db.query<{ n: string }>("SELECT note AS n FROM bookmarks WHERE tweet_id=$1", [tweetIds[3]])).rows[0].n).toBe("A synthetic owner note");
  const annotationCounts = await db.query<{ tags: number; collections: number }>(
    "SELECT (SELECT count(*)::int FROM bookmark_tags WHERE bookmark_id=b.id) tags,(SELECT count(*)::int FROM collection_bookmarks WHERE bookmark_id=b.id) collections FROM bookmarks b WHERE tweet_id=$1", [tweetIds[3]],
  );
  expect(annotationCounts.rows[0]).toEqual({ tags: 1, collections: 1 });

  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete bookmark" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM bookmarks WHERE tweet_id=$1", [tweetIds[3]])).rows[0].n).toBe(0);
  const remainder = await db.query<{ n: number }>("SELECT count(*)::int n FROM bookmarks WHERE tweet_id=ANY($1::text[])", [[tweetIds[4], tweetIds[5]]]);
  expect(remainder.rows[0].n).toBe(2);
  const selectors = page.getByLabel("Select bookmark");
  await selectors.nth(0).check();
  await selectors.nth(1).check();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete 2 selected" }).click();
  await expect(page.getByText("2 bookmark(s) deleted.")).toBeVisible();
  const afterBulkDelete = await db.query<{ n: number }>("SELECT count(*)::int n FROM bookmarks WHERE tweet_id=ANY($1::text[])", [[tweetIds[4], tweetIds[5]]]);
  expect(afterBulkDelete.rows[0].n).toBe(0);

  page.once("dialog", dialog => dialog.accept("e2e-renamed-collection"));
  await page.getByRole("button", { name: "collection: e2e-synthetic-collection" }).click();
  await expect(page.getByRole("button", { name: "collection: e2e-renamed-collection" })).toBeVisible();
  page.on("dialog", dialog => dialog.type() === "prompt" ? dialog.accept("") : dialog.accept());
  await page.getByRole("button", { name: "collection: e2e-renamed-collection" }).click();
  await expect.poll(async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM collections WHERE name='e2e-renamed-collection'")).rows[0].n).toBe(0);
  await page.getByRole("button", { name: "tag: e2e-synthetic-tag" }).click();
  await expect.poll(async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM tags WHERE name=$1", [tagName])).rows[0].n).toBe(0);
  await cleanTestData();
});

test.afterAll(async () => {
  if (!pool) return;
  try {
    await cleanTestData();
  } finally {
    await pool.end();
    pool = undefined;
  }
});
