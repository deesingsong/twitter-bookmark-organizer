import { describe, expect, it, vi } from "vitest";
import * as contracts from "@/lib/embeddings/contracts";
import { decodeSemanticCursor, encodeSemanticCursor, semanticSearchSchema, semanticSearchSignature } from "./semantic-request";
import { EMBEDDING_CONTRACT } from "@/lib/embeddings/contracts";

const vector = [1, ...Array<number>(383).fill(0)];
const input = { q: "café", mode: "meaning", contract: EMBEDDING_CONTRACT, queryVector: vector };
const bookmarkId = "00000000-0000-4000-8000-000000000001";

describe("semantic cursor contract", () => {
  it("hashes normalized-equivalent query text and vector identically", () => {
    const first = semanticSearchSchema.parse(input);
    const rounded = semanticSearchSchema.parse({ ...input, q: " cafe\u0301 ", queryVector: [1.0005, ...vector.slice(1)] });
    const signature = semanticSearchSignature(first);
    expect(semanticSearchSignature(rounded)).toBe(signature);
    const cursor = encodeSemanticCursor(signature, bookmarkId);
    expect(decodeSemanticCursor(cursor, signature)).toBe(bookmarkId);
    const serialized = Buffer.from(cursor, "base64url").toString();
    expect(serialized).not.toContain(input.q);
    expect(serialized).not.toContain(JSON.stringify(vector));
  });

  it.each(["not-json", "[]", '[2,"signature","bad-id"]', '[1,"signature","bad-id"]'])("rejects malformed and legacy cursor data: %s", (value) => {
    const cursor = Buffer.from(value).toString("base64url");
    expect(() => decodeSemanticCursor(cursor, "signature")).toThrow();
  });

  it("invalidates cursors when any pinned embedding contract changes", async () => {
    const parsed = semanticSearchSchema.parse(input);
    const signature = semanticSearchSignature(parsed);
    const cursor = encodeSemanticCursor(signature, bookmarkId);
    try {
      vi.resetModules();
      vi.doMock("@/lib/embeddings/contracts", () => ({
        ...contracts,
        EMBEDDING_CONTRACT: { ...contracts.EMBEDDING_CONTRACT, modelRevision: "synthetic-future-revision" },
      }));
      const future = await import("./semantic-request");
      const futureSignature = future.semanticSearchSignature(future.semanticSearchSchema.parse(input));
      expect(futureSignature).not.toBe(signature);
      expect(() => future.decodeSemanticCursor(cursor, futureSignature)).toThrow("invalid_cursor");
    } finally {
      vi.doUnmock("@/lib/embeddings/contracts");
      vi.resetModules();
    }
  });
});
