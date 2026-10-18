import { beforeEach, describe, expect, it, vi } from "vitest";
import { withDatabase } from "@/db";
import * as library from "@/app/api/bookmarks/route";
import * as bookmark from "@/app/api/bookmarks/[id]/route";
import * as bulkDelete from "@/app/api/bookmarks/bulk-delete/route";
import * as search from "@/app/api/bookmarks/search/route";
import * as bookmarkOrganization from "@/app/api/bookmarks/[id]/organize/route";
import * as imports from "@/app/api/imports/route";
import * as batches from "@/app/api/imports/[jobId]/batches/route";
import * as organization from "@/app/api/organize/route";
import * as organizationItem from "@/app/api/organize/[kind]/[id]/route";
import * as embeddingStatus from "@/app/api/embeddings/status/route";
import * as embeddingClaim from "@/app/api/embeddings/claim/route";
import * as embeddingComplete from "@/app/api/embeddings/complete/route";
import * as embeddingFail from "@/app/api/embeddings/fail/route";
import * as embeddingRetry from "@/app/api/embeddings/retry/route";
import { TWITTER_BOOKMARKS_V1 } from "@/lib/import/twitter-bookmarks-v1";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ withDatabase: vi.fn() }));

const origin = "https://library.example.test";
const id = "00000000-0000-4000-8000-000000000001";
const bookmarkContext = { params: Promise.resolve({ id }) };
const batchContext = { params: Promise.resolve({ jobId: id }) };
const organizationContext = { params: Promise.resolve({ kind: "tag", id }) };

const mutations = [
  { method: "POST", path: "/api/imports", run: imports.POST },
  { method: "POST", path: `/api/imports/${id}/batches`, run: (request: Request) => batches.POST(request, batchContext) },
  { method: "PATCH", path: `/api/bookmarks/${id}`, run: (request: Request) => bookmark.PATCH(request, bookmarkContext) },
  { method: "DELETE", path: `/api/bookmarks/${id}`, run: (request: Request) => bookmark.DELETE(request, bookmarkContext) },
  { method: "POST", path: "/api/bookmarks/bulk-delete", run: bulkDelete.POST },
  { method: "POST", path: "/api/bookmarks/search", run: search.POST },
  { method: "POST", path: `/api/bookmarks/${id}/organize`, run: (request: Request) => bookmarkOrganization.POST(request, bookmarkContext) },
  { method: "POST", path: "/api/organize", run: organization.POST },
  { method: "PATCH", path: `/api/organize/tag/${id}`, run: (request: Request) => organizationItem.PATCH(request, organizationContext) },
  { method: "DELETE", path: `/api/organize/tag/${id}`, run: (request: Request) => organizationItem.DELETE(request, organizationContext) },
  { method: "POST", path: "/api/embeddings/claim", run: embeddingClaim.POST },
  { method: "POST", path: "/api/embeddings/complete", run: embeddingComplete.POST },
  { method: "POST", path: "/api/embeddings/fail", run: embeddingFail.POST },
  { method: "POST", path: "/api/embeddings/retry", run: embeddingRetry.POST },
];

const reads = [
  { path: "/api/bookmarks", error: "library_unavailable", run: (request: Request) => library.GET(request) },
  { path: `/api/bookmarks/${id}`, error: "bookmark_unavailable", run: (request: Request) => bookmark.GET(request, bookmarkContext) },
  { path: "/api/imports", error: "database_unavailable", run: () => imports.GET() },
  { path: "/api/organize", error: "organizer_unavailable", run: () => organization.GET() },
  { path: "/api/embeddings/status", error: "embedding_index_unavailable", run: () => embeddingStatus.GET() },
];

beforeEach(() => vi.resetAllMocks());

describe("API privacy boundaries", () => {
  it.each(mutations)("$method $path rejects an opaque Origin before database access", async ({ method, path, run }) => {
    const response = await run(new Request(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        host: "library.example.test",
        origin: "null",
        referer: `${origin}/library`,
      },
      body: "{}",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "same_origin_required" });
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(withDatabase).not.toHaveBeenCalled();
  });

  it.each(reads)("GET $path sanitizes database failures in a non-cacheable response", async ({ path, error, run }) => {
    vi.mocked(withDatabase).mockRejectedValue(new Error("synthetic private database details"));
    const response = await run(new Request(`${origin}${path}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error });
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("sanitizes a failed import-status query after an import job was created or resumed", async () => {
    vi.mocked(withDatabase)
      .mockResolvedValueOnce({ job: { id }, resumed: true, matches: true })
      .mockRejectedValueOnce(new Error("synthetic private import details"));
    const response = await imports.POST(new Request(`${origin}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        sourceFormat: TWITTER_BOOKMARKS_V1,
        fileHash: "a".repeat(64),
        totalSeen: 1,
        expectedBatches: 1,
        duplicateWithinFile: 0,
        invalid: 0,
      }),
    }));
    expect(withDatabase).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "database_unavailable" });
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });
});
