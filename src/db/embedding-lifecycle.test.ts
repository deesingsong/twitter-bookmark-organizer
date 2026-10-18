import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateDrizzleJson, generateMigration, type DrizzleSnapshotJSON } from "drizzle-kit/api";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import * as schema from "./schema";

const readProjectFile = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const migration = readProjectFile("drizzle/0004_embedding_lifecycle.sql");
const previous = JSON.parse(readProjectFile("drizzle/meta/0002_snapshot.json")) as DrizzleSnapshotJSON;
const snapshot = JSON.parse(readProjectFile("drizzle/meta/0004_snapshot.json")) as DrizzleSnapshotJSON;
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const table = getTableConfig(schema.bookmarkEmbeddings);
const dialect = new PgDialect();
const checks = Object.fromEntries(table.checks.map((check) => [
  check.name,
  normalize(dialect.sqlToQuery(check.value).sql),
]));

function functionBody(name: string): string {
  const definition = migration.match(new RegExp(
    `CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\([^]*?LANGUAGE (?:sql|plpgsql) AS \\$\\$([^]*?)\\$\\$;`,
  ));
  expect(definition, `${name} must be defined by the additive migration`).not.toBeNull();
  return definition![1];
}

describe("embedding lifecycle schema and additive migration (no database connection)", () => {
  it("keeps the generated snapshot aligned with the schema and migration journal", () => {
    expect(generateDrizzleJson(schema, previous.id).tables).toEqual(snapshot.tables);
    expect(snapshot.prevId).toBe(previous.id);

    const journal = JSON.parse(readProjectFile("drizzle/meta/_journal.json")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.slice(-2).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 3, tag: "0003_search_identifier_regex" },
      { idx: 4, tag: "0004_embedding_lifecycle" },
    ]);
    expect(journal.entries.at(-1)!.when).toBeGreaterThan(journal.entries.at(-2)!.when);
  });

  it("includes every generated DDL change without dropping data or resizing vectors", async () => {
    const statements = await generateMigration(previous, snapshot);
    for (const statement of statements) {
      // Existing vectors receive an explicit unknown version before the current default is set.
      const compatibleStatement = statement.replace(
        "ADD COLUMN \"preprocessing_version\" text DEFAULT 'bge-small-en-v1.5-enriched-v1'",
        "ADD COLUMN \"preprocessing_version\" text DEFAULT 'legacy-unknown'",
      );
      expect(normalize(migration)).toContain(normalize(compatibleStatement));
    }
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)|ALTER\s+COLUMN\s+"?embedding"?\s+(?:SET\s+DATA\s+)?TYPE/i);
    expect(schema.bookmarkEmbeddings.embedding.getSQLType()).toBe("vector(384)");
    expect(table.foreignKeys[0].onDelete).toBe("cascade");
  });

  it("records the fixed dimension and preprocessing contract with bounded attempts", () => {
    expect(schema.bookmarkEmbeddings.dimensions.default).toBe(384);
    expect(schema.bookmarkEmbeddings.preprocessingVersion.default).toBe("bge-small-en-v1.5-enriched-v1");
    expect(schema.bookmarkEmbeddings.attemptCount.default).toBe(0);
    expect(schema.bookmarkEmbeddings.claimToken.getSQLType()).toBe("uuid");
    expect(schema.bookmarkEmbeddings.leaseExpiresAt.getSQLType()).toBe("timestamp with time zone");
    expect(checks.bookmark_embeddings_dimensions_check).toContain('"dimensions" = 384');
    expect(checks.bookmark_embeddings_attempt_count_check).toContain('"attempt_count" between 0 and 3');
    expect(checks.bookmark_embeddings_status_check).toContain("('pending', 'processing', 'stale', 'ready', 'failed')");
  });

  it("requires a complete processing lease and a current vector for ready rows", () => {
    const leaseCheck = checks.bookmark_embeddings_processing_claim_check;
    expect(leaseCheck).toMatch(/"status" = 'processing'.*"claim_token" is not null.*"lease_expires_at" is not null.*"attempt_count" > 0/);
    expect(leaseCheck).toMatch(/"status" <> 'processing'.*"claim_token" is null.*"lease_expires_at" is null/);
    expect(checks.bookmark_embeddings_vector_state_check).toMatch(/"status" <> 'pending' or .*"embedding" is null/);
    expect(checks.bookmark_embeddings_vector_state_check).toMatch(/"status" <> 'stale' or .*"embedding" is not null/);
    expect(checks.bookmark_embeddings_vector_state_check).toMatch(/"status" <> 'ready' or \(.*"embedding" is not null and .*"indexed_at" is not null\)/);
  });

  it("indexes available work separately from processing lease expiry", () => {
    const indexes = snapshot.tables["public.bookmark_embeddings"].indexes;
    expect(indexes.bookmark_embeddings_pending_idx.columns.map((column: { expression: string }) => column.expression))
      .toEqual(["status", "attempt_count", "bookmark_id"]);
    expect(indexes.bookmark_embeddings_pending_idx.where)
      .toContain("in ('pending', 'stale') and \"bookmark_embeddings\".\"attempt_count\" < 3");
    expect(indexes.bookmark_embeddings_lease_expiry_idx.columns.map((column: { expression: string }) => column.expression))
      .toEqual(["lease_expires_at", "bookmark_id"]);
    expect(indexes.bookmark_embeddings_lease_expiry_idx.where).toContain("= 'processing'");
  });

  it("marks existing vectors for reindexing before enabling the current contract default", () => {
    const legacyVersion = migration.indexOf("DEFAULT 'legacy-unknown'");
    const invalidation = migration.indexOf('UPDATE "bookmark_embeddings"');
    const currentDefault = migration.indexOf("SET DEFAULT 'bge-small-en-v1.5-enriched-v1'");
    const stateConstraint = migration.indexOf('ADD CONSTRAINT "bookmark_embeddings_vector_state_check"');
    expect(legacyVersion).toBeGreaterThan(-1);
    expect(invalidation).toBeGreaterThan(legacyVersion);
    expect(currentDefault).toBeGreaterThan(invalidation);
    expect(stateConstraint).toBeGreaterThan(currentDefault);
    expect(migration.slice(invalidation, currentDefault)).toContain("CASE WHEN \"embedding\" IS NULL THEN 'pending' ELSE 'stale' END");
  });

  it("invalidates active claims without creating missing rows or overwriting vectors", () => {
    const body = functionBody("invalidate_bookmark_embedding");
    expect(body).toContain("CASE WHEN embedding IS NULL THEN 'pending' ELSE 'stale' END");
    for (const assignment of [
      "claim_token = NULL", "lease_expires_at = NULL", "attempt_count = 0", "indexed_at = NULL", "last_error = NULL",
    ]) expect(body).toContain(assignment);
    expect(body).toContain("WHERE bookmark_id = p_bookmark_id");
    expect(body).not.toMatch(/\b(?:INSERT|DELETE)\b|\bembedding\s*=/i);
  });

  it("only watches selected bookmark content fields and skips unchanged values", () => {
    const watchedColumns = migration.match(/AFTER UPDATE OF ([^\n]+) ON public\.bookmarks/);
    expect(watchedColumns?.[1]).toBe("text, quoted_tweet, note");
    const body = functionBody("mark_bookmark_embedding_stale");
    for (const column of ["text", "quoted_tweet", "note"]) {
      expect(body).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(body).not.toMatch(/author|url|created_at|bookmarked_at|source_metadata/i);
    expect(body).toContain("public.invalidate_bookmark_embedding(NEW.id)");
  });

  it("covers tag insert/delete, moves between bookmarks, and tag renames", () => {
    expect(migration).toContain("AFTER INSERT OR UPDATE OF bookmark_id, tag_id OR DELETE ON public.bookmark_tags");
    const body = functionBody("bookmark_tags_embedding_invalidation_trigger");
    expect(body).toContain("TG_OP = 'DELETE'");
    expect(body).toContain("OLD.bookmark_id IS DISTINCT FROM NEW.bookmark_id");
    expect(body).toContain("OLD.tag_id IS NOT DISTINCT FROM NEW.tag_id");
    expect(body).toContain("public.invalidate_bookmark_embedding(OLD.bookmark_id)");
    expect(body).toContain("public.invalidate_bookmark_embedding(NEW.bookmark_id)");
    expect(migration).toContain("AFTER UPDATE OF name ON public.tags");
    expect(functionBody("tags_embedding_invalidation_trigger")).toContain("NEW.name IS DISTINCT FROM OLD.name");
  });
});
