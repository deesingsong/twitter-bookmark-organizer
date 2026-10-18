import { describe, expect, it } from "vitest";
import { MAX_SEARCH_QUERY_LENGTH, parseSearchQuery } from "@/lib/search/query";

describe("search query parsing", () => {
  it("returns an empty search for blank input without enabling fuzzy matching", () => {
    expect(parseSearchQuery(" \n\t ")).toEqual({
      normalized: "", tweetIds: [], canonicalUrls: [], handles: [], hashtags: [],
      phrases: [], literals: [], terms: [], fuzzyText: null,
    });
  });

  it("preserves snowflake identity as text beyond JavaScript number precision", () => {
    const parsed = parseSearchQuery("900719925474099312345678901234");
    expect(parsed.tweetIds).toEqual(["900719925474099312345678901234"]);
    expect(parsed.fuzzyText).toBeNull();
    expect(parseSearchQuery("0").tweetIds).toEqual(["0"]);
    expect(parseSearchQuery("0".repeat(31)).literals).toEqual(["0".repeat(31)]);
  });

  it.each([
    "https://x.com/sample_user/status/9007199254740993?s=20#fragment",
    "http://twitter.com/sample_user/status/9007199254740993/",
    "https://mobile.twitter.com/sample_user/status/9007199254740993/photo/1",
    "https://www.x.com/i/web/status/9007199254740993",
    "https://www.mobile.x.com/sample_user/status/9007199254740993",
    "MOBILE.TWITTER.COM/sample_user/status/9007199254740993",
    "x.com/i/web/status/9007199254740993",
  ])("canonicalizes supported status URL %s", (query) => {
    const parsed = parseSearchQuery(query);
    expect(parsed.tweetIds).toEqual(["9007199254740993"]);
    expect(parsed.canonicalUrls).toEqual(["https://x.com/i/web/status/9007199254740993"]);
    expect(parsed.fuzzyText).toBeNull();
  });

  it.each([
    "https://x.com.evil.test/sample/status/9007199254740993",
    "https://x.com@evil.test/sample/status/9007199254740993",
    "https://evil.test@x.com/sample/status/9007199254740993",
    "https://example.test/sample/status/9007199254740993",
    "ftp://x.com/sample/status/9007199254740993",
    "javascript:alert(1)",
    "https://x.com/sample/status/9007199254740993oops",
    "https://x.com/sample/status/" + "9".repeat(31),
    "https://x.com/sample",
  ])("keeps unsupported or deceptive URLs literal: %s", (query) => {
    const parsed = parseSearchQuery(query);
    expect(parsed.tweetIds).toEqual([]);
    expect(parsed.canonicalUrls).toEqual([]);
    expect(parsed.literals).toEqual([query]);
  });

  it("normalizes handles and Unicode hashtags without confusing package names or email", () => {
    const parsed = parseSearchQuery("@Sample_User #MachineLearning #cafe\u0301 @scope/pkg a@example.test");
    expect(parsed.handles).toEqual(["sample_user"]);
    expect(parsed.hashtags).toEqual(["machinelearning", "café"]);
    expect(parsed.literals).toEqual(["@scope/pkg", "a@example.test"]);
    expect(parsed.fuzzyText).toBeNull();
  });

  it("rejects malformed handle syntax as literal text", () => {
    expect(parseSearchQuery("@@sample @bad-name @").literals).toEqual(["@@sample", "@bad-name", "@"]);
    expect(parseSearchQuery(`@${"a".repeat(65)}`).handles).toEqual([]);
  });

  it("keeps quoted phrases and technical literals independent in a mixed query", () => {
    const parsed = parseSearchQuery('  @Sample_User "vector search" Qwen3-0.6B-GGUF #AI practical  ');
    expect(parsed.normalized).toBe('@Sample_User "vector search" Qwen3-0.6B-GGUF #AI practical');
    expect(parsed.phrases).toEqual(["vector search"]);
    expect(parsed.literals).toEqual(["Qwen3-0.6B-GGUF"]);
    expect(parsed.terms).toEqual(["practical"]);
    expect(parsed.fuzzyText).toBeNull();
  });

  it("preserves case, punctuation, and meaningful spacing within quoted values", () => {
    const parsed = parseSearchQuery('“C++   API” "@Sample_User #AI" `std::vector<T>`');
    expect(parsed.phrases).toEqual(["C++   API", "@Sample_User #AI"]);
    expect(parsed.literals).toEqual(["std::vector<T>"]);
    expect(parsed.handles).toEqual([]);
    expect(parsed.hashtags).toEqual([]);
  });

  it("unescapes only a quote delimiter or backslash within grouped values", () => {
    const parsed = parseSearchQuery(String.raw`"say \"hello\"" "C:\\temp\path"`);
    expect(parsed.phrases).toEqual(['say "hello"', String.raw`C:\temp\path`]);
  });

  it.each(['"unfinished phrase', "`unfinished literal", "“unfinished phrase", '""', '"   "']) (
    "preserves incomplete or empty quoted intent: %s", (query) => {
      const parsed = parseSearchQuery(query);
      expect(parsed.literals).toEqual([query]);
      expect(parsed.terms).toEqual([]);
      expect(parsed.fuzzyText).toBeNull();
    },
  );

  it("does not strip punctuation out of technical strings or SQL-looking text", () => {
    const query = "C++ C# .NET Node.js v1.2.3 foo_bar [CLS] --flag C:\\temp %_ x' OR 1=1";
    const parsed = parseSearchQuery(query);
    expect(parsed.normalized).toBe(query);
    expect(parsed.literals).toEqual([
      "C++", "C#", ".NET", "Node.js", "v1.2.3", "foo_bar", "[CLS]", "--flag", "C:\\temp", "%_", "x'", "1=1",
    ]);
    expect(parsed.terms).toEqual(["OR"]);
    expect(parsed.fuzzyText).toBeNull();
  });

  it("deduplicates exact paths without changing their first-seen order", () => {
    const parsed = parseSearchQuery('9007199254740993 https://twitter.com/a/status/9007199254740993 @A @a #B #b "same" "same" C++ C++');
    expect(parsed.tweetIds).toEqual(["9007199254740993"]);
    expect(parsed.canonicalUrls).toEqual(["https://x.com/i/web/status/9007199254740993"]);
    expect(parsed.handles).toEqual(["a"]);
    expect(parsed.hashtags).toEqual(["b"]);
    expect(parsed.phrases).toEqual(["same"]);
    expect(parsed.literals).toEqual(["C++"]);
  });

  it("allows fuzzy fallback only for ordinary queries containing at least four letters", () => {
    expect(parseSearchQuery("api").fuzzyText).toBeNull();
    expect(parseSearchQuery("APIS").fuzzyText).toBe("apis");
    expect(parseSearchQuery("  Databse\n performance  ").fuzzyText).toBe("databse performance");
    expect(parseSearchQuery("a b").fuzzyText).toBeNull();
    expect(parseSearchQuery("中文").fuzzyText).toBeNull();
    expect(parseSearchQuery("资料检索").fuzzyText).toBe("资料检索");
    expect(parseSearchQuery("don't panic").terms).toEqual(["don't", "panic"]);
    expect(parseSearchQuery("plain @sample").fuzzyText).toBeNull();
    expect(parseSearchQuery('plain "search"').fuzzyText).toBeNull();
  });

  it("rejects excessive input without truncating query meaning", () => {
    expect(() => parseSearchQuery("a".repeat(MAX_SEARCH_QUERY_LENGTH))).not.toThrow();
    expect(() => parseSearchQuery("a".repeat(MAX_SEARCH_QUERY_LENGTH + 1))).toThrow(RangeError);
    expect(() => parseSearchQuery(" ".repeat(MAX_SEARCH_QUERY_LENGTH + 1))).toThrow(RangeError);
  });
});
