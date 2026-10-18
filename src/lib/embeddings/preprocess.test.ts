import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMBEDDING_CONTRACT, type EmbeddingDocumentInput } from "./contracts";
import {
  embeddingDocumentHash,
  hashEmbeddingDocument,
  prepareEmbeddingDocument,
  prepareEmbeddingQuery,
} from "./preprocess";

const document: EmbeddingDocumentInput = {
  text: "A synthetic primary passage.",
  quotedText: "A synthetic quoted passage.",
  note: "A synthetic owner note.",
  tags: ["Beta", "alpha"],
};

describe("enriched embedding document preprocessing", () => {
  it("matches the evaluated field order and labels without a primary-text prefix", () => {
    expect(prepareEmbeddingDocument(document)).toBe([
      "A synthetic primary passage.",
      "Quoted text: A synthetic quoted passage.",
      "Owner note: A synthetic owner note.",
      "Owner tags: Beta, alpha",
    ].join("\n"));
  });

  it("normalizes line endings and trims only field boundaries", () => {
    expect(prepareEmbeddingDocument({
      text: " \tFirst  line\r\n\r\nSecond\rthird \t\n",
      quotedText: "\r\n quote  one\rquote two \t",
      note: "\t note  one\r\nnote two \r",
      tags: [" Beta ", "\talpha\rline\n"],
    })).toBe([
      "First  line\n\nSecond\nthird",
      "Quoted text: quote  one\nquote two",
      "Owner note: note  one\nnote two",
      "Owner tags: Beta, alpha\nline",
    ].join("\n"));
  });

  it("omits absent, null, and whitespace-only optional fields", () => {
    const primary = "Only the primary text.";
    expect(prepareEmbeddingDocument({ text: primary })).toBe(primary);
    expect(prepareEmbeddingDocument({ text: primary, quotedText: null, note: null, tags: null })).toBe(primary);
    expect(prepareEmbeddingDocument({ text: primary, quotedText: " \r\n", note: "\t", tags: ["", " \n"] })).toBe(primary);
    expect(prepareEmbeddingDocument({ text: primary, tags: [] })).toBe(primary);
    expect(prepareEmbeddingDocument({})).toBe("");
  });

  it("keeps useful context when primary text is absent", () => {
    expect(prepareEmbeddingDocument({ text: null, note: "Synthetic annotation", tags: ["context"] }))
      .toBe("Owner note: Synthetic annotation\nOwner tags: context");
  });

  it("sorts and deduplicates tags by code point without mutating the caller", () => {
    const tags = [" Zulu ", "alpha", "Zulu", " "];
    expect(prepareEmbeddingDocument({ tags })).toBe("Owner tags: Zulu, alpha");
    expect(tags).toEqual([" Zulu ", "alpha", "Zulu", " "]);
  });

  it("ignores identity, URLs, usernames, dates, collections, language, and relevance metadata", async () => {
    const original = {
      ...document,
      id: "synthetic-row-a",
      tweetId: "1900000000000000001",
      canonicalUrl: "https://x.com/example/status/1900000000000000001",
      originalUrl: "https://twitter.com/example/status/1900000000000000001?test=1",
      authorUsername: "example",
      username: "example",
      tweetCreatedAt: "2026-01-01T00:00:00.000Z",
      bookmarkedAt: "2026-01-02T00:00:00.000Z",
      firstImportedAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z",
      collections: ["Synthetic collection"],
      language: "en",
      relevance: { "query-a": 3 },
    };
    const changed = {
      ...original,
      id: "synthetic-row-b",
      tweetId: "1900000000000000002",
      canonicalUrl: "https://x.com/other/status/1900000000000000002",
      originalUrl: "https://twitter.com/other/status/1900000000000000002",
      authorUsername: "other",
      username: "other",
      tweetCreatedAt: null,
      bookmarkedAt: null,
      firstImportedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
      collections: ["Different collection"],
      language: "fr",
      relevance: { "query-b": 1 },
    };
    expect(prepareEmbeddingDocument(original)).toBe(prepareEmbeddingDocument(changed));
    expect(await embeddingDocumentHash(original)).toBe(await embeddingDocumentHash(changed));
  });
});

describe("embedding document hashes", () => {
  it("hashes the exact final prepared text and preprocessing version as UTF-8 SHA-256", async () => {
    const prepared = prepareEmbeddingDocument(document);
    const expected = createHash("sha256")
      .update(JSON.stringify([EMBEDDING_CONTRACT.preprocessingVersion, prepared]), "utf8")
      .digest("hex");
    const actual = await embeddingDocumentHash(document);
    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[a-f0-9]{64}$/);
    expect(actual).toBe(await hashEmbeddingDocument(prepared));
    expect(actual).toBe(await embeddingDocumentHash({ ...document }));
  });

  it.each([
    ["primary text", { ...document, text: "A changed synthetic primary passage." }],
    ["quote", { ...document, quotedText: "A changed synthetic quoted passage." }],
    ["note", { ...document, note: "A changed synthetic owner note." }],
    ["tag value", { ...document, tags: ["Gamma", "alpha"] }],
    ["tag addition", { ...document, tags: ["Beta", "alpha", "Gamma"] }],
    ["quote removal", { ...document, quotedText: null }],
    ["note removal", { ...document, note: null }],
    ["tag removal", { ...document, tags: [] }],
  ] satisfies [string, EmbeddingDocumentInput][])("changes the hash for a changed %s", async (_, changed) => {
    expect(await embeddingDocumentHash(changed)).not.toBe(await embeddingDocumentHash(document));
  });

  it("treats normalized field boundaries, line endings, and empty optional fields identically", async () => {
    const canonical = { text: "First\nsecond", tags: ["tag"] };
    const equivalent = {
      text: " \tFirst\r\nsecond\n",
      quotedText: "\r ",
      note: "\t",
      tags: ["", " tag ", "\r\n"],
    };
    expect(await embeddingDocumentHash(equivalent)).toBe(await embeddingDocumentHash(canonical));
    expect(await embeddingDocumentHash({ text: "First\rsecond", tags: ["tag"] }))
      .toBe(await embeddingDocumentHash(canonical));
  });

  it("treats reordered and duplicate tags identically", async () => {
    expect(prepareEmbeddingDocument({ text: "x", tags: ["z", "a", "z"] }))
      .toBe(prepareEmbeddingDocument({ text: "x", tags: ["a", "z"] }));
    expect(await embeddingDocumentHash({ text: "x", tags: ["z", "a", "z"] }))
      .toBe(await embeddingDocumentHash({ text: "x", tags: ["a", "z"] }));
  });

  it("changes the hash when preprocessing version changes", async () => {
    const prepared = prepareEmbeddingDocument(document);
    expect(await hashEmbeddingDocument(prepared, "bge-small-en-v1.5-enriched-v2"))
      .not.toBe(await hashEmbeddingDocument(prepared));
  });

  it("does not confuse version and text boundaries", async () => {
    expect(await hashEmbeddingDocument("b\nc", "a")).not.toBe(await hashEmbeddingDocument("c", "a\nb"));
  });
});

describe("BGE query preprocessing", () => {
  it("adds exactly the pinned query prefix without document labels or query rewriting", () => {
    const query = "  Synthetic query\r\nwith detail?  ";
    expect(prepareEmbeddingQuery(query))
      .toBe("Represent this sentence for searching relevant passages:   Synthetic query\r\nwith detail?  ");
    expect(prepareEmbeddingQuery("")).toBe("Represent this sentence for searching relevant passages: ");
  });
});
