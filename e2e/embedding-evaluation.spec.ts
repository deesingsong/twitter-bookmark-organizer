import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "@neondatabase/serverless";
import { config as loadEnv } from "dotenv";
import { expect, test, type Page } from "@playwright/test";
import { SYNTHETIC_SEMANTIC_DOCUMENTS, SYNTHETIC_SEMANTIC_QUERIES } from "../src/lib/search/evaluation/semantic/fixtures";
import { cosineSimilarity, truncateAndNormalize } from "../src/lib/search/evaluation/semantic/vectors";
import { runSemanticEvaluation } from "../src/lib/search/evaluation/semantic/evaluate";
import { reciprocalRankFusion } from "../src/lib/search/rrf";
import { requireLocalE2ETarget } from "./local-target";

loadEnv({ path: ".env.local" });

interface EmbeddingArtifact {
  schemaVersion: 1;
  model: {
    id: string;
    revision: string;
    transformersJs: string;
    queryPrefix: string;
    documentPrefix: string;
    configVisionAudioNull?: boolean;
  };
  backend: string;
  dtype: string;
  dimension: number;
  allFinite: boolean;
  initializationMs: number;
  modelLoadMs: number;
  elapsedMs: number;
  vectorsPerSecond: number;
  queryWarmSamplesMs: number[];
  fixture: { documentCount: number; queryCount: number; dimensions?: number[]; documentDimensions?: number[]; queryDimensions?: number[] };
  documents: { id: string; vector?: number[]; sourceVector?: number[]; enrichedVector?: number[] }[];
  queries: { id: string; kind: string; context?: string | null; language?: string; vector: number[] }[];
}

const artifactDirectory = path.join(process.cwd(), ".tmp-workspace", "embedding-benchmark");
const availableArtifacts = existsSync(artifactDirectory)
  ? readdirSync(artifactDirectory).filter((name) => name.startsWith("evaluation-") && name.endsWith(".json")).map((name) => path.join(artifactDirectory, name))
  : [];
const fixtureIds = new Map(SYNTHETIC_SEMANTIC_DOCUMENTS.map((document) => [document.id, stableUuid(document.id)]));
const allBookmarkIds = [...fixtureIds.values()];
const tagPrefix = "m4-synthetic-eval-";
let pool: Pool | undefined;
const tagIds = new Map<string, string>();

function stableUuid(key: string): string {
  const hex = createHash("sha256").update(`m4-semantic-fixture:${key}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function databasePool(): Pool {
  if (pool) return pool;
  const target = requireLocalE2ETarget();
  pool = new Pool({ connectionString: target.directConnectionString, max: 1 });
  return pool;
}

async function cleanup(): Promise<void> {
  const db = databasePool();
  await db.query("delete from bookmarks where id = any($1::uuid[])", [allBookmarkIds]);
  await db.query("delete from tags where name like $1", [`${tagPrefix}%`]);
  tagIds.clear();
}

async function seed(): Promise<void> {
  const db = databasePool();
  await cleanup();
  for (const [index, document] of SYNTHETIC_SEMANTIC_DOCUMENTS.entries()) {
    const quotedTweet = document.quotedText ? { text: document.quotedText } : null;
    await db.query(`insert into bookmarks
      (id,tweet_id,canonical_url,text,author_username,author_display_name,quoted_tweet,note,language,tweet_created_at,has_media,source_metadata)
      values ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,false,'{"source":"synthetic-m4-evaluation"}'::jsonb)`,
    [fixtureIds.get(document.id), document.tweetId, document.canonicalUrl, document.text, document.authorUsername, quotedTweet, document.note ?? null, document.language, new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()]);
  }
  const tagNames = new Set(SYNTHETIC_SEMANTIC_DOCUMENTS.flatMap((document) => document.tags ?? []));
  for (const name of tagNames) {
    const inserted = await db.query<{ id: string }>("insert into tags(name) values($1) returning id", [`${tagPrefix}${name}`]);
    tagIds.set(name, inserted.rows[0].id);
  }
  for (const document of SYNTHETIC_SEMANTIC_DOCUMENTS) {
    for (const name of document.tags ?? []) {
      await db.query("insert into bookmark_tags(bookmark_id,tag_id) values($1,$2)", [fixtureIds.get(document.id), tagIds.get(name)]);
    }
  }
}

interface SearchResult { id: string; matchKind: string | null }
async function lexicalResults(page: Page, query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ q: query, limit: "50", sort: "relevance" });
    if (cursor) params.set("cursor", cursor);
    const response = await page.request.get(`/api/bookmarks?${params}`);
    if (!response.ok()) throw new Error("Lexical evaluation request failed.");
    const body = await response.json() as { bookmarks: SearchResult[]; nextCursor: string | null };
    results.push(...body.bookmarks);
    cursor = body.nextCursor;
  } while (cursor);
  return results;
}

function artifactReport(pathname: string): EmbeddingArtifact {
  const value = JSON.parse(readFileSync(pathname, "utf8")) as EmbeddingArtifact;
  expect(value.schemaVersion).toBe(1);
  expect(value.fixture.documentCount).toBe(SYNTHETIC_SEMANTIC_DOCUMENTS.length);
  expect(value.fixture.queryCount).toBe(SYNTHETIC_SEMANTIC_QUERIES.length);
  const documentDimensions = value.fixture.documentDimensions ?? value.fixture.dimensions;
  const queryDimensions = value.fixture.queryDimensions ?? value.fixture.dimensions ?? documentDimensions;
  expect(documentDimensions?.length).toBeGreaterThan(0);
  expect(documentDimensions?.every((dimension) => Number.isInteger(dimension) && dimension > 0)).toBe(true);
  expect(queryDimensions).toEqual(documentDimensions);
  expect(value.allFinite).toBe(true);
  const embeddingSize = Math.max(...(documentDimensions ?? []));
  expect(value.documents.map(({ id }) => id)).toEqual(SYNTHETIC_SEMANTIC_DOCUMENTS.map(({ id }) => id));
  expect(value.queries.map(({ id }) => id)).toEqual(SYNTHETIC_SEMANTIC_QUERIES.map(({ id }) => id));
  for (const document of value.documents) {
    const sourceVector = document.sourceVector ?? document.vector;
    expect(sourceVector).toHaveLength(embeddingSize);
    expect(sourceVector?.every(Number.isFinite)).toBe(true);
    if (document.enrichedVector) {
      expect(document.enrichedVector).toHaveLength(embeddingSize);
      expect(document.enrichedVector.every(Number.isFinite)).toBe(true);
    }
  }
  for (const query of value.queries) {
    expect(query.vector).toHaveLength(embeddingSize);
    expect(query.vector.every(Number.isFinite)).toBe(true);
  }
  return value;
}

const dimensionsByArtifact = new Map(availableArtifacts.map((pathname) => {
  const artifact = artifactReport(pathname);
  return [pathname, artifact.fixture.documentDimensions ?? artifact.fixture.dimensions ?? []] as const;
}));
const sourceArtifacts = availableArtifacts.filter((pathname) => !pathname.endsWith("-enriched.json"));

test.describe("local synthetic embedding retrieval evaluation", () => {
  test.skip(availableArtifacts.length === 0, "Run the isolated local browser benchmark to generate ignored embedding artifacts first.");

  test.beforeAll(seed);
  test.afterAll(async () => {
    if (!pool) return;
    try { await cleanup(); } finally { await pool.end(); pool = undefined; }
  });

  for (const artifactPath of sourceArtifacts) {
    for (const dimensions of dimensionsByArtifact.get(artifactPath) ?? []) {
      test(`${path.basename(artifactPath)} ${dimensions}d: lexical, semantic, and RRF`, async ({ page }) => {
        test.setTimeout(300_000);
        const artifact = artifactReport(artifactPath);
        const enrichedPath = artifactPath.replace(/\.json$/, "-enriched.json");
        const enrichedArtifact = existsSync(enrichedPath) ? artifactReport(enrichedPath) : undefined;
        const queryIndex = new Map(artifact.queries.map((query, index) => [query.id, index]));
        const documentVectors = artifact.documents.map((document) => truncateAndNormalize(document.sourceVector ?? document.vector ?? [], dimensions));
        const enrichedDocumentVectors = enrichedArtifact?.documents.map((document) => truncateAndNormalize(document.sourceVector ?? document.vector ?? [], dimensions));
        const queryVectors = artifact.queries.map((query) => truncateAndNormalize(query.vector, dimensions));
        const idByBookmark = new Map([...fixtureIds].map(([fixtureId, bookmarkId]) => [bookmarkId, fixtureId]));
        const lexicalByQuery = new Map<string, SearchResult[]>();
        const lexicalRanker = async (query: (typeof SYNTHETIC_SEMANTIC_QUERIES)[number]) => {
          let result = lexicalByQuery.get(query.id);
          if (!result) {
            result = await lexicalResults(page, query.query);
            lexicalByQuery.set(query.id, result);
          }
          return result.map(({ id }) => idByBookmark.get(id)).filter((id): id is string => Boolean(id));
        };
        const semanticRanker = (query: (typeof SYNTHETIC_SEMANTIC_QUERIES)[number], enriched = false) => {
          const qIndex = queryIndex.get(query.id);
          if (qIndex === undefined) throw new Error("Embedding artifact does not contain a requested query.");
          const q = queryVectors[qIndex];
          const scored = artifact.documents.map((document, index) => ({
            id: document.id,
            score: cosineSimilarity(q, enriched
              ? (document.enrichedVector
                ? truncateAndNormalize(document.enrichedVector, dimensions)
                : enrichedDocumentVectors?.[index] ?? documentVectors[index])
              : documentVectors[index]),
          }));
          return scored.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).map(({ id }) => id);
        };
        const exactPriorityKinds = new Set(["exact", "literal", "metadata"]);
        const hybridRanker = async (query: (typeof SYNTHETIC_SEMANTIC_QUERIES)[number]) => {
          const [lexical, semantic] = await Promise.all([lexicalRanker(query), Promise.resolve(semanticRanker(query))]);
          const fused = reciprocalRankFusion([lexical, semantic], { constant: 60, limit: SYNTHETIC_SEMANTIC_DOCUMENTS.length }).map(({ id }) => id);
          if (query.kind !== "exact") return fused;
          const exactIds = (lexicalByQuery.get(query.id) ?? [])
            .filter((item) => item.matchKind && exactPriorityKinds.has(item.matchKind))
            .map((item) => idByBookmark.get(item.id)).filter((id): id is string => Boolean(id));
          const exactSet = new Set(exactIds);
          return [...exactIds, ...fused.filter((id) => !exactSet.has(id))];
        };

        const [lexicalReport, semanticReport, enrichedReport, hybridReport] = await Promise.all([
          runSemanticEvaluation(lexicalRanker),
          runSemanticEvaluation(semanticRanker),
          runSemanticEvaluation((query) => semanticRanker(query, true)),
          runSemanticEvaluation(hybridRanker),
        ]);
        // Ensure all vectors in the artifact align with the same source fixture.
        expect(artifact.queries).toHaveLength(SYNTHETIC_SEMANTIC_QUERIES.length);
        const metrics = {
          model: { ...artifact.model, backend: artifact.backend, dtype: artifact.dtype },
          runtime: { initializationMs: artifact.initializationMs, modelLoadMs: artifact.modelLoadMs, elapsedMs: artifact.elapsedMs, vectorsPerSecond: artifact.vectorsPerSecond, queryWarmSamplesMs: artifact.queryWarmSamplesMs },
          dimensions,
          enrichedArtifactCompared: Boolean(enrichedArtifact),
          reports: Object.fromEntries(["lexical", "semantic-primary", "semantic-enriched", "hybrid-rrf-60"].map((name, i) => {
            const report = [lexicalReport, semanticReport, enrichedReport, hybridReport][i]!;
            return [name, {
              recallAt5: report.meanRecallAt5,
              recallAt10: report.meanRecallAt10,
              precisionAt10: report.meanPrecisionAt10,
              mrrAt10: report.meanReciprocalRankAt10,
              ndcgAt10: report.meanNdcgAt10,
              byKind: report.byKind,
            }];
          })),
        };
        appendFileSync(path.join(artifactDirectory, "retrieval-results.jsonl"), `${JSON.stringify(metrics)}\n`);
        console.info("Synthetic embedding retrieval metrics", JSON.stringify(metrics));
        expect(lexicalReport.queryCount).toBe(88);
        expect(semanticReport.queryCount).toBe(88);
        expect(enrichedReport.queryCount).toBe(88);
        expect(hybridReport.queryCount).toBe(88);
        expect(semanticReport.meanNdcgAt10).not.toBeNull();
      });
    }
  }
});
