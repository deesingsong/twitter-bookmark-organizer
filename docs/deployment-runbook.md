# Private deployment runbook

This runbook covers Milestone 5 delivery and owner checks. **Personal archive import is BLOCKED until Vercel Authentication on All Deployments, anonymous and unauthorized-account denial, automation bypass review, owner access, and database separation are verified.** Anonymous denial has passed for the specific production and preview paths recorded below; the other gates remain open. Use synthetic records while validating. No personal archive contents, credentials, bypass values, or real vectors belong in this document or the public repository.

## Evidence at M5 kickoff — 2026-10-18

| Area | Confirmed evidence | Remaining gate |
| --- | --- | --- |
| Application | Import, organization, deletion, lexical search, local embeddings and hybrid retrieval exist in the source tree. | Integrate the M5 audit and rerun regressions. |
| Local tests | Default Vitest run: 293 passed, 6 guarded database tests skipped. Separate M5 opt-in runs: indexing 5/5 and semantic route 1/1 passed. Earlier M4 Playwright run: 18 passed. | Complete the remaining M5 regressions/E2E suite; record skips and failures honestly. |
| Development database | Local pooled/direct configuration identifies `bookmark_dev`. M5 guarded suites passed using the selected direct development URL; no production target was used. | Verify least privilege and environment isolation; recheck target identity and contents before subsequent database tests. |
| Neon management API | Authenticated CLI inventory failed DNS resolution (`ENOTFOUND`); direct development PostgreSQL test connections succeeded separately. | Recheck management connectivity; preview/production resources and separation remain unverified. |
| Vercel | Connection authenticated on Hobby; no matching project was found at kickoff. | Create/link the intended project, protect it, then verify delivery and access. |
| Privacy and devices | No personal archive imported; no production database accessed or modified. | Anonymous denial, unauthorized-account denial, owner desktop/Android access and production/preview isolation are **UNVERIFIED / BLOCKED**. |

These are dated observations, not proof of current deployment settings. Update the evidence after each completed gate.

## Protect before using private data

1. Review the exact source publication list. Keep the personal archive, environment files, model/benchmark output, test artifacts, and the local planning files out of Git. Confirm `AGENTS.md` and `PROJECT_SPEC.md` remain in `.git/info/exclude`.
2. Create or select the intended Vercel project. Before its first deployment, set a team default for Vercel Authentication on All Deployments where available, then verify the project setting itself. Use native GitHub integration for builds; a prior CLI deployment failure does not establish a GitHub deployment failure.
3. In the project, open **Security → Deployment Protection**. Enable **Vercel Authentication**, choose **All Deployments**, and save. Reopen the setting to confirm persistence. Vercel made this available on every plan, including Hobby, at no added cost on [9 September 2026](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan). If the actual account cannot save it, record the failure and keep import blocked.
4. Confirm only the owner's account has access. Review team/project membership, access groups, previously granted requests, shareable links, deployment exceptions, trusted sources and automation bypass paths. Remove unused grants and bypasses; retain no public preview exception. Review the [documented access and bypass rules](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).
5. Read back the project protection setting: `ssoProtection.deploymentType` must equal `"all"`. The default Standard Protection value does not cover the production domain. Record the result without storing tokens or other account identifiers.
6. Deploy a non-sensitive build, then perform the independent denial checks below before adding any personal-data database connection. A successful build or authenticated tool fetch is insufficient evidence of privacy.

Vercel Authentication is the external access gate for every UI and API route. The app has no separate account system. The owner's passkey belongs to their Vercel account. Localhost does not provide this platform gate and must stay on a trusted machine/network.

## Separate database environments

| Environment | Target and credential rule |
| --- | --- |
| Local development/test | Dedicated development database; existing guarded tests expect `bookmark_dev`. Confirm this database contains no personal data. |
| Vercel Preview | Separate preview branch/project, populated only with synthetic records. Never inherit production credentials. |
| Vercel Production | Separate production branch/project. Configure only after project protection is saved and independently checked; do not import personal records before full access acceptance. |

Configure pooled `DATABASE_URL` for app traffic and direct `DATABASE_URL_UNPOOLED` for migrations in each intended environment. Store them as server-only secrets. Verify the host, database and role for each target without copying connection strings into logs, docs or chat. Check that preview and production do not resolve to the same database, and review the role's permissions. Naming a branch or database does not prove isolation or least privilege.

Apply reviewed `drizzle/` migrations only after the target environment and authorization are confirmed. `npm run db:check` checks migration metadata; it does not contact PostgreSQL or prove applied schema parity. Verify applied migrations, `vector`, `pg_trgm`, uniqueness and delete cascades against the selected database. Never use the production database for regression tests.

After environment setup, redeploy and repeat the denial matrix. Check every preview branch's environment mapping, not only the current production deployment.

## Independent access checks

Use a fresh browser profile/incognito session with no Vercel login, deployment cookie, share-link parameters, authorization header or automation bypass. Ordinary `curl.exe` without credentials can check the initial response; do not substitute `vercel curl` or authenticated connector fetches for anonymous checks. A 200 response containing only the Vercel login page can still be a gate; inspect the redirect destination and returned content. App content, a successful application response or a mutation reaching the app is a failure.

For each origin below, test `/`, one actual `/_next/static/` asset, read endpoints such as `/api/bookmarks`, `/api/bookmarks/search?q=synthetic`, and `/api/embeddings/status`, and state-changing import/organization/delete/indexing paths. Use a synthetic validation database and invalid, non-mutating payloads for unauthorized method checks. Authentication must occur before application validation or database work. A missing route or an application-generated validation error does not prove platform protection.

| Origin | Anonymous denial | Unauthorized Vercel account denied | Owner allowed |
| --- | --- | --- | --- |
| Production alias/domain | PASS: fresh no-cookie checks redirected to Vercel SSO for UI, APIs, CSS and tested mutation paths | UNVERIFIED | UNVERIFIED |
| Generated production deployment URL | PASS: fresh no-cookie checks redirected to Vercel SSO for UI, APIs and CSS | UNVERIFIED | UNVERIFIED |
| Preview alias/branch URL | PASS: fresh no-cookie checks redirected to Vercel SSO for UI, APIs and CSS | UNVERIFIED | UNVERIFIED |
| Generated preview deployment URL | PASS: fresh no-cookie checks redirected to Vercel SSO for UI, APIs and CSS | UNVERIFIED | UNVERIFIED |
| Other aliases/custom domains, if any | UNVERIFIED | UNVERIFIED | UNVERIFIED |

The unauthorized account must receive the Vercel access gate or access-request page and no bookmark data. Do not approve its access request. Record date, environment/URL type, request method/path, observed status/redirect, and pass/fail. Keep actual deployment inventory and account details in an owner-controlled record; record only non-sensitive summaries here. If no unauthorized account is available, leave that acceptance check unverified.

## Owner acceptance with synthetic data

On desktop and a physical Android device, sign in with the owner's Vercel account/passkey and verify:

- Import, overlapping import, repeat import and interrupted resume produce accurate disjoint counters and no duplicate identities.
- Notes, tags and collections survive an overlapping import; filters and cursor pagination remain usable.
- Exact, phrase and typo search work; meaning/hybrid search returns synthetic conceptual matches with matching filters.
- Model download, WebGPU/WASM fallback, pause/reload/resume and model-unavailable states are understandable; exact search still works when inference fails. Record the phone/browser and observed model timing without promising unmeasured multilingual quality.
- Single and bulk deletion require confirmation, remove dependent embeddings/joins, and allow a later fresh import of the same synthetic post.
- Signing out and using a clean browser restores denial on the tested origins. Inspect build output and request/error logs for accidental secrets or bookmark content before any real archive is connected.

Browser viewport emulation and an authenticated desktop session do not complete the physical Android or unauthorized-account checks.

## Local verification

After `npm ci`, run `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:check`, and `npm run build`. These checks do not verify remote Vercel protection or production database isolation.

Before `npm run test:e2e`, confirm `.env.local` selects only the intended development endpoint and that pooled/direct URLs match. E2E runs a local app, writes synthetic fixtures and cleans them up through guarded development paths. Review the current guards before running; do not weaken them to reach production.

Two Vitest database suites also require explicit opt-in and do not load `.env.local` themselves:

- Indexing: `RUN_EMBEDDING_INDEXING_DB_TESTS=1` and `EMBEDDING_TEST_DATABASE_URL` targeting the verified `bookmark_dev` database. Queue-wide claim/retry coverage requires the database to be otherwise empty.
- Semantic route: `RUN_SEMANTIC_SEARCH_DB_TESTS=1` and the same `EMBEDDING_TEST_DATABASE_URL`; `src/lib/search/semantic-live.integration.test.ts` verifies the selected database is `bookmark_dev` and otherwise empty before seeding.

Use the existing local credential source in process memory; keep values out of shell history and reports. The optional embedding evaluation E2E check also needs locally generated ignored benchmark artifacts. Report an absent artifact as a skip, not a passing evaluation.

Record M5 command results separately from the kickoff results above. No successful local test can replace the live denial matrix.

## Completion record

M5 remains **UNVERIFIED / BLOCKED** until each item has dated evidence:

- [ ] M5 local audit and regressions pass, with justified skips recorded.
- [ ] Preview/production databases, roles, environment mappings and migrations are verified separately.
- [ ] GitHub-triggered production and preview deployments succeed.
- [ ] All Deployments is saved and read back; only the owner retains access and needed bypass paths are reviewed.
- [ ] Every applicable anonymous and unauthorized-account denial cell passes, including APIs and assets.
- [ ] The owner completes desktop and physical Android acceptance with synthetic data.
- [ ] No secrets, personal archive contents or real vectors appear in published source, static output or logs.

Only after these checks pass may the owner authorize connecting/importing the personal archive. Record any remaining limitation explicitly instead of marking delivery complete.

## Latest local and provider status - 2026-10-18

- Integrated local verification: TypeScript passed; ESLint passed with two existing warnings; Drizzle migration metadata check passed; Vitest passed 325 tests with six guarded database tests skipped by default. The five embedding-indexing database tests and one semantic-route database test passed separately against the guarded `bookmark_dev` database.
- Playwright: all 23 E2E tests passed at desktop and emulated mobile viewports, including synthetic imports, transaction rollback/replay, annotation preservation, cleanup, search evaluation, and a synthetic 1k/10k/50k-row latency run. The separate optional browser-generated retrieval artifacts were present and evaluated. Final direct database counts were zero for bookmarks, embeddings, import jobs/batches, tags, and collections.
- Production build passed. The regular sandbox invocation first failed creating ignored `.next` output with Windows `EPERM`; rerunning through the approved local execution path passed.
- Vercel: project `twitter-bookmark-organizer` uses Next.js on Node 22 and reads back Vercel Authentication enabled with `ssoProtection.deploymentType: "all"`. GitHub-triggered production (`2e66d36`) and preview (`6ccfcb9`, PR #1) builds reached READY. Environment inventory previously returned no variables; no database credentials are attached. Fresh no-cookie requests to production alias/generated URL and preview alias/generated URL received Vercel SSO redirects (302) for `/`, `/api/bookmarks`, `/api/imports`, `/api/embeddings/status`, and a CSS asset. Representative anonymous POST requests to imports, bulk deletion, and embedding claim returned 401; anonymous bookmark DELETE returned a Vercel SSO redirect (302). This verifies anonymous denial for the tested paths only. Owner sign-in and unauthorized-account denial remain unverified; membership/grant/share-link review is incomplete.
- Protection bypass: while checking an authenticated preview endpoint, Vercel CLI reported that it generated a Protection Bypass for Automation token. The value was not recorded or emitted into project files. The current Vercel MCP credential is forbidden from reading the project and CLI requests now fail during npm registry update lookup, so this session could not inspect/revoke the generated bypass. Treat bypass inventory/revocation as **UNVERIFIED / BLOCKED**. Before real data is connected, the owner must inspect Security → Deployment Protection → Protection Bypass for Automation and revoke this unneeded secret; verify there are no other unnecessary bypass secrets or system environment variables. Vercel documents that these tokens bypass SSO until revoked: https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation.
- Neon management inventory remains unavailable because `console.neon.tech` DNS resolution failed earlier. No production or preview Neon database has been provisioned or migrated. The Vercel project has no production/preview database credentials.
- Anonymous denial was verified for the listed production and preview paths. Unauthorized-account denial and owner sign-in have not been tested. Desktop Vercel authentication and physical Android acceptance remain unverified.

These local results do not clear the security gate. Real archive import remains BLOCKED until Neon environment separation, GitHub-triggered deployments, independent access denial, and owner/device acceptance are completed.

- Preview: PR #1 (`m5-protection-check`) produced a READY protected preview. Its UI, API paths, and CSS were denied to fresh no-cookie requests. Preview database credentials are not configured. The PR is documentation-only and remains open pending runbook updates.

## Continuation check - 2026-10-18

- Standalone Vercel MCP: no standalone `mcp.vercel.com` tool was exposed to this session, so an authenticated project-inspection invocation could not be made. Whether this session followed a full client restart is not independently observable. The active Codex config is accepted by `codex mcp list`, but that only validates configuration, not runtime authentication. This remains **UNVERIFIED** and is non-blocking for dashboard/GitHub work.
- Vercel app connector (separate from standalone MCP): authenticated identity lookup succeeded, but the team list returned empty. A read-only project lookup using the known team slug returned HTTP 403 `forbidden`: `Not authorized: Trying to access resource under scope "deesingsongs-projects". You must re-authenticate to this scope or use a token with access to this scope.` This session therefore cannot inspect membership, protection exceptions, shareable links, or bypass inventory through that connector.
- Vercel CLI fallback: one read-only `project inspect` attempt stopped in the CLI update-check worker (`Worker timed out after 10 seconds`, followed by `Failed to spawn get latest worker` / `EPIPE`) before the project API was reached. No CLI reinstall, account reconnection, or configuration rewrite was attempted.
- Automation bypass: the repository has no `VERCEL_AUTOMATION_BYPASS_SECRET` references and the current process has no such environment variable. Local synthetic tests do not use a deployment bypass. Dashboard-level inventory and other external test dependencies remain **UNVERIFIED**; keep the value out of logs/config and revoke it from **Security → Deployment Protection → Protection Bypass for Automation** if the owner confirms no external test process depends on it. Do not use it for owner-login or anonymous-denial checks.
- Owner and unauthorized-account checks remain **UNVERIFIED** because neither interactive account session is available here. The connected browser opens Vercel's login page for `/dashboard`; it has no existing owner session. The existing no-cookie results remain limited to the routes and deployment URLs recorded above. Production provisioning remains blocked by the project’s go-live gate until owner access, unauthorized denial, grants/exceptions review, and protection readback are complete.
- No production Neon project/database was created; no migrations, synthetic production smoke tests, or personal archive import were run. The access gate was not satisfied, and the Vercel project inspection path is currently unavailable.

## Protection recheck - 2026-10-19

- The owner reports changing this project from All Deployments to Standard Protection and revoking the automation bypass. These dashboard changes could not be read back: the Vercel app connector still returns HTTP 403 for the project scope, and the standalone Vercel MCP is not exposed in this session.
- Repeated read-only Vercel project and deployment lookups still return `403 forbidden` for scope `deesingsongs-projects`; the team list remains empty. The protection change and bypass revocation did not resolve the connector authorization error. They are separate controls from connector access.
- With no cookies in an isolated browser context, `https://twitter-bookmark-organizer.vercel.app/` returned a public Savory marketing site, not this repository's application. This hostname was inferred from the project name; its attachment to the intended Vercel project could not be verified due the API 403. Treat the hostname as an unresolved domain mismatch and do not send data to it.
- Standard Protection does not protect production domains; Vercel's current documentation distinguishes it from All Deployments, which covers production domains as well. Restore All Deployments until the intended project/domain binding is confirmed. See https://vercel.com/docs/deployment-protection and https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan.
- GitHub's Vercel status checks for the recorded production commit (`2e66d36`) and preview commit (`6ccfcb9`) still report success. This confirms those recorded GitHub integration checks; it does not establish current access protection or current deployment-to-domain binding.
- Bypass revocation is owner-reported and not independently confirmed. No bypass value was requested, used, or recreated. No production database or personal archive is connected.

## Continuation update — 2026-10-19

This dated update supersedes any earlier statements above that no production Neon project exists or that current deployment protection is verified:

- **Neon:** With the owner's explicit approval, created the dedicated Free project `twitter-bookmark-organizer-production` in `aws-ap-southeast-1` (Singapore), PostgreSQL 17. Applied the checked-in Drizzle migrations successfully using the direct URL held only in process memory. No credentials were written to `.env.local`, Git, or Vercel. No synthetic data or personal archive was inserted. Production schema migration succeeded; production smoke tests remain blocked until the Vercel privacy gate is independently verified.
- **Vercel:** The owner reports changing the setting to Standard Protection and revoking the automation bypass. Neither setting was read back. Vercel's current documentation says Standard Protection does not cover production domains; All Deployments does. Therefore production access protection is **UNVERIFIED / BLOCKED**. On 2026-10-19 a clean browser context visiting the known PR #1 preview root was redirected to Vercel SSO (302), confirming anonymous denial for that root only. No current production origin is verified, and no API endpoints were tested in this pass.
- **GitHub:** The recorded main production check and PR #1 Preview check remain successful GitHub-triggered builds. This verifies the deployment path only, not privacy. PR #1 remains open; no merge or production deployment was performed in this continuation.
- **Code audit:** Search request settings now run inside the same database transaction as their queries, with transaction-local `statement_timeout` and pg_trgm threshold settings. This avoids relying on session settings across Neon pooled transactions.
- **Local verification:** TypeScript passed; ESLint passed with two existing warnings; Drizzle static migration check passed; Vitest passed 325 tests with six guarded skips; production build passed. The 2026-10-18 development integration checks (five indexing tests and one semantic route test) and 23 Playwright desktop/emulated-mobile tests remain historical evidence; they were not rerun here. Physical Android is unverified.

### Owner actions before any personal archive import

1. In the intended Vercel project, restore Vercel Authentication to **All Deployments**, save, reopen, and independently verify the setting covers production and every preview/generated deployment URL.
2. Review project/team members, grants, share links, exceptions, trusted sources, and automation bypass inventory. Verify bypass revocation rather than relying on the report alone.
3. Identify and verify the actual production domain and current preview URL. Test anonymous denial for UI, assets, read APIs, and state-changing APIs. Test with the owner account and a separate unauthorized Vercel account.
4. Configure separate production and preview Neon credentials in the corresponding Vercel environments only after the access review passes. Keep the production URL out of preview and local development.
5. Run bounded synthetic production smoke tests, verify schema/extensions and cascades, then clean all synthetic rows. Confirm preview isolation and physical Android access.
6. Only after every gate passes, explicitly authorize the personal archive import.

Until these actions are complete, personal archive import remains **BLOCKED**. The staging branch was pushed through GitHub, and its Vercel Preview check succeeded on commit `111dc643`. No production deployment was initiated, and no personal bookmark data was uploaded.

## Final integration recheck — 2026-10-19

### Owner-confirmed Vercel access results

The owner reports Vercel Authentication set to **All Deployments**, owner access to production and the current staging Preview, authentication required from incognito on both, and no unintended users or access grants. On 2026-10-19, the owner additionally confirmed reviewing the automation bypass inventory, Shareable Links, deployment protection exceptions, and Trusted Sources, and reported no bypasses, share links, or exceptions. These dashboard checks are owner-confirmed; this session cannot independently read them back. The owner has not tested a separate unauthorized Vercel account.

The Vercel project API currently returns 403 for this session's project scope. I therefore could not independently read protection settings, membership, domains, bypass inventory, or environment-variable metadata, and I did not retry the historical CLI path. The owner supplied the production deployment origin, and the Vercel GitHub bot supplied the current Preview origin on PR #2. In a new Playwright browser context with no stored state, no cookies, and no authorization or bypass headers, one parallel no-cookie request pass returned Vercel SSO redirects (302) for the page, bookmarks read API, and search read API on both origins. The import and bulk-delete endpoints returned 401 on both origins when sent empty JSON bodies; these invalid requests did not create or delete data. This independently confirms anonymous denial for those representative routes on both deployment origins. It does not verify every API route, static asset path, a separate unauthorized Vercel account, the dashboard's All Deployments setting, or protection exceptions/Trusted Sources. The owner reports no unintended users or grants and says bypass was revoked; these dashboard facts remain owner-confirmed rather than independently read back.

### Production Neon read-only audit

Project `twitter-bookmark-organizer-production` (`proud-forest-76521048`), region `aws-ap-southeast-1`, reports PostgreSQL 17.11. A read-only transaction confirmed `neondb`, five applied Drizzle migrations, `vector` 0.8.0, `pg_trgm` 1.6, the `vector(384)` embedding column, and the expected bookmark identity/search and embedding lifecycle indexes. The embedding lifecycle and search triggers were present. Counts were zero for bookmarks (including notes), tags, bookmark-tag relationships, collections, collection-bookmark relationships, embeddings, import jobs, and import batches. No rows were inserted or changed.

### Environment and release state

The app runtime reads server-only `DATABASE_URL`; `DATABASE_URL_UNPOOLED` is used by the local Drizzle migration config. The owner reports that the pooled production `DATABASE_URL` has been configured in Vercel for Production only. This session cannot read environment mappings back, so the variable scope and Preview's lack of access to production Neon remain owner-reported and unverified here. No credentials were written to local files or Git. Preview database isolation is unverified.

The staging branch has six changed files and no commits behind `main` at the last comparison. It contains the transaction-local search settings fix and updated status documentation; PR #2's latest GitHub-triggered Preview is Ready at `https://twitter-bookmark-organizer-git-sta-fa284f-deesingsongs-projects.vercel.app`. PR #1 remains open and documentation-only. PR #2 from `staging/vercel-test` to `main` is open for review; no PR is merged automatically.

After the transaction-local settings change, the guarded semantic-search route integration test passed 1/1 on the isolated development `bookmark_dev` database using synthetic records; its cleanup assertion confirmed zero bookmarks and embeddings afterward. Synthetic production application tests were not run: PR #2 remains unmerged, and no owner-authenticated browser/API session is available here. The production database remains empty. The production database remains empty.

### Android owner procedure

After the production environment and protected deployment are ready, use Android Chrome signed in through Vercel Authentication. Record device model, Android/Chrome versions, first and cached model initialization times, and whether inference reports WebGPU or WASM. Browse synthetic bookmarks, try filters and search, edit a note, manage a collection, run semantic and hybrid search, background/reopen Chrome to check session and model-cache persistence, and note responsiveness on Wi-Fi and mobile data. Clean all synthetic records afterward. Do not use the personal archive for this acceptance test.
