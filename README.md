# Private X Bookmark Library

A single-owner library for importing and organizing an existing X/Twitter bookmark archive. The application is designed for Vercel and Neon PostgreSQL. It does not implement app accounts, X scraping, public sharing, or any export path.

## Status

The Milestone 1–4 implementation includes:

- A versioned archive adapter, browser parsing, bounded uploads, transactional deduplication, import history, and retry/resume.
- A responsive library with filters, bookmark detail, notes, tags, collections, and single/bulk deletion with confirmation.
- Exact identifiers, URLs, handles and phrases, PostgreSQL full-text search, and bounded typo matching.
- Optional local browser embeddings, resumable indexing, pgvector retrieval, hybrid reciprocal-rank fusion, and lexical fallback when the model is unavailable.

Milestone 5 was functionally accepted for desktop use on 2026-10-21 after the owner completed synthetic production acceptance. The owner verified Production deployment and database connectivity; Vercel Authentication and anonymous denial on tested routes; Production-only Neon configuration and Preview isolation; synthetic fixture import, deduplication, and preservation of notes, tags, and collections across reimports; Exact, Meaning, and All search; BGE-small inference on WebGPU; embedding persistence after refresh; individual and bulk deletion; and final cleanup. A direct production Neon check found zero rows across all eight application tables. This acceptance does not cover denial of a separate unauthorized Vercel account, physical Android compatibility/performance, or full-scale indexing and retrieval against the personal archive. The first personal archive import has not been authorized or performed. See the [deployment runbook](docs/deployment-runbook.md) for the acceptance record and remaining limitations.

## Requirements

- Node.js 22 or newer
- npm
- A Neon PostgreSQL database with the `vector` and `pg_trgm` extensions available
- A Vercel project configured for **Vercel Authentication on All Deployments**

## Local development

1. Copy `.env.example` to `.env.local` and set `DATABASE_URL` to the pooled URL and `DATABASE_URL_UNPOOLED` to the direct URL for a development-only Neon branch. Keep production credentials out of local and preview environments.
2. Install pinned dependencies with `npm ci`.
3. Review the SQL in `drizzle/` and run `npm run db:check` with the development environment configured. This checks migration metadata; it does not prove that the database is reachable or migrated.
4. Apply the checked-in migrations only to the intended development database with `npm run db:migrate`. Confirm that database supports both extensions before applying them.
5. Start the app with `npm run dev`. The import screen accepts the observed version 1 archive format; use synthetic data for validation.

The database client is server-only. Do not import it into client components or expose `DATABASE_URL` through `NEXT_PUBLIC_*` variables. CI runs without a database and never imports private archive contents.

## Neon setup

Use separate Neon projects or branches for local development, Vercel preview, and production. Grant the app role only the access needed by the application. Keep the production URL in the Vercel Production environment only. Configure pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED` separately for each environment. Drizzle migrations use the direct URL; app traffic uses the pooled URL.

Synthetic validation uses the dedicated Singapore development database `bookmark_dev` on PostgreSQL 17 with pgvector. During M5, all five guarded indexing checks and the guarded semantic-route check passed against the explicitly selected direct development URL. A separate Neon Free production project (`twitter-bookmark-organizer-production`) was created in Singapore on PostgreSQL 17 on 2026-10-19, and the checked-in Drizzle migrations applied successfully. The owner has since verified production database connectivity and confirmed the pooled production `DATABASE_URL` is Production-only, with Preview isolated from production Neon. The production acceptance run used only the committed synthetic fixture and was cleaned up; a direct check found zero rows in all eight application tables. Connection-string values have not been written to the repository or local environment.

## Vercel owner-only protection checklist

Use Vercel's native GitHub integration for production and preview deployments. Enable the protection gate before deploying or connecting a database containing personal data. A successful deployment does not verify access protection; the application depends on the external Vercel gate.

Vercel Authentication can protect production and previews on every plan, including Hobby, at no additional cost, according to the [9 September 2026 Vercel announcement](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan). In the project, open **Security → Deployment Protection**, enable **Vercel Authentication**, select **All Deployments**, and save. Confirm the current setting in the dashboard; the equivalent API readback is `ssoProtection.deploymentType: "all"`. [Vercel authentication documentation](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).

Before importing any real archive:

1. Select the intended Vercel project and confirm project/team access is limited to the owner's Vercel account.
2. Save and read back **Vercel Authentication → All Deployments**, covering production domains, previews, and generated deployment URLs. Passkeys sign the owner into their Vercel account.
3. Review project/team members, access groups and granted access, deployment protection exceptions, shareable links, trusted sources, and automation bypasses. Remove access and bypass paths the owner does not need, then connect the GitHub integration for non-sensitive builds.
4. Confirm production and preview deployments use their own Neon environment URLs; preview/local must not point to production.
5. After deploying a non-sensitive build, test production, preview, direct deployment URLs, assets, and APIs anonymously and with an unauthorized Vercel account. Confirm the owner can use the protected app on desktop and Android. Use the runbook's matrix and synthetic data only.
6. Record the date, tested URLs/environment types (not secrets), and result. The owner completed desktop production acceptance on 2026-10-21, including anonymous denial for the tested routes. A separate unauthorized-account denial test remains unverified; the personal archive import has not been authorized.

If the dashboard cannot save the required protection or independent access tests fail, keep personal import blocked and report the exact failure. Full setup order and evidence requirements are in the [deployment runbook](docs/deployment-runbook.md).

## Database architecture

Drizzle schema definitions are in `src/db/schema.ts`; migrations are reviewed under `drizzle/`. Tweet IDs are text, tweet ID and canonical URL uniqueness are database-enforced, and owner notes are stored separately from imported source metadata. Tags, collections, embeddings, import jobs, and uniquely numbered batches have dedicated tables. Deleting a bookmark cascades to its joins and embedding; no tombstone or deleted-item registry exists. Active jobs are unique by source format and archive hash, and batch writes are transactional and replay-safe. Text changes mark associated embeddings stale. The actual archive structure is summarized in `docs/archive-structure.md` without personal content.

The importer validates JSON in the browser, computes a SHA-256 file identity, and sends bounded batches. It preserves populated imported fields and never sends or updates notes/tags/collections. Each committed batch reports inserted, enriched, or already-existing records; parser-level duplicates and invalid records are counted separately. Re-selecting an interrupted file resumes completed batches. Import endpoints depend on the external Vercel deployment gate described above; local development endpoints do not implement custom authentication.

## Local semantic search

The browser Web Worker uses the pinned BGE-small-en-v1.5 ONNX contract in `src/lib/embeddings/contracts.ts`: 384 dimensions, CLS pooling, L2 normalization, and distinct documented query/document preprocessing. It downloads model assets for local inference, attempts WebGPU where available, and falls back to WASM. First use needs network access and model download time. Indexing resumes from persisted state; changed content becomes stale, and late results cannot recreate deleted bookmarks. Lexical search remains available when inference fails.

This is an English embedding model; multilingual semantic quality and physical Android performance are unverified. See the [model comparison](docs/embedding-evaluation.md) and [synthetic retrieval evaluation](docs/search-evaluation.md) for measured results and limitations. No paid embedding API is required.

## Validation

After `npm ci`, run `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:check`, and `npm run build`. The default Vitest run skips database suites that require explicit opt-in; a passing default run does not verify those integration checks.

Run `npm run test:e2e` only with `.env.local` identifying the intended dedicated development database. The suite uses matching pooled/direct Neon URLs for `bookmark_dev`, target guards, and synthetic records. Guarded Vitest database checks require their own explicit environment variables; see the [runbook](docs/deployment-runbook.md#local-verification). Confirm the target and current contents before any database test or migration. Never point these commands at production.

The latest local run passed typechecking, Drizzle migration checks, production build, and 325 Vitest tests (six guarded tests skipped). ESLint completed with two existing warnings. The guarded semantic-search database integration test passed 1/1 against development after the transaction settings change, with synthetic cleanup verified. Earlier development checks passed five indexing tests, and 23 Playwright tests passed with desktop/mobile emulation on 2026-10-18. Owner-run production functional acceptance passed for desktop on 2026-10-21. Unauthorized-account denial, physical Android compatibility/performance, and full-scale personal-archive indexing/retrieval remain unverified.
