import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiError, jsonResponse, readJsonRequest } from "@/lib/api/http";

const BodySchema = z.object({ count: z.number().int() }).strict();

function request(body: string, headers: Record<string, string> = {}) {
  return new Request("https://library.example.test/api/imports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "library.example.test",
      ...headers,
    },
    body,
  });
}

describe("same-origin JSON request validation", () => {
  it("accepts an origin matching the request host", async () => {
    const result = await readJsonRequest(request('{"count":2}', { Origin: "https://library.example.test" }), BodySchema, 100);
    expect(result).toEqual({ ok: true, data: { count: 2 } });
  });

  it("uses a matching referer when browsers omit Origin", async () => {
    const result = await readJsonRequest(request('{"count":2}', { Referer: "https://library.example.test/library" }), BodySchema, 100);
    expect(result).toEqual({ ok: true, data: { count: 2 } });
  });

  it.each([
    "null",
    "",
    "not-an-origin",
    "https://library.example.test/path",
    "https://library.example.test/",
    "https://user:password@library.example.test",
    "blob:https://library.example.test/opaque",
    "https://library.example.test https://attacker.example",
  ])("rejects explicit opaque or malformed Origin %j despite a matching Referer", async (origin) => {
    const result = await readJsonRequest(request('{"count":2}', {
      Origin: origin,
      Referer: "https://library.example.test/library",
    }), BodySchema, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: "same_origin_required" });
    }
  });

  it("uses Host for local addresses when the framework URL has an internal hostname", async () => {
    const result = await readJsonRequest(new Request("http://localhost:3000/api/imports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "127.0.0.1:3000",
        Origin: "http://127.0.0.1:3000",
      },
      body: '{"count":2}',
    }), BodySchema, 100);
    expect(result).toEqual({ ok: true, data: { count: 2 } });
  });

  it("rejects cross-origin sources even when a forwarded host is supplied", async () => {
    const result = await readJsonRequest(request('{"count":2}', {
      Origin: "https://attacker.example",
      "X-Forwarded-Host": "library.example.test",
    }), BodySchema, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("does not let a forwarded host replace the request Host", async () => {
    const result = await readJsonRequest(request('{"count":2}', {
      Origin: "https://attacker.example",
      "X-Forwarded-Host": "attacker.example",
    }), BodySchema, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("does not let a forwarded protocol replace the request protocol", async () => {
    const result = await readJsonRequest(request('{"count":2}', {
      Origin: "http://library.example.test",
      "X-Forwarded-Proto": "http",
    }), BodySchema, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects cross-site fetch metadata", async () => {
    const result = await readJsonRequest(request('{"count":2}', {
      Origin: "https://library.example.test",
      "Sec-Fetch-Site": "cross-site",
    }), BodySchema, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects oversized, non-JSON, malformed, and invalid bodies without echoing values", async () => {
    const validOrigin = { Origin: "https://library.example.test" };
    const oversized = await readJsonRequest(request('{"count":123}', validOrigin), BodySchema, 4);
    const wrongType = await readJsonRequest(request('{"count":2}', { ...validOrigin, "Content-Type": "text/plain" }), BodySchema, 100);
    const malformed = await readJsonRequest(request("{", validOrigin), BodySchema, 100);
    const invalid = await readJsonRequest(request('{"count":"private-value"}', validOrigin), BodySchema, 100);

    expect(oversized.ok).toBe(false);
    expect(wrongType.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(await invalid.response.text()).not.toContain("private-value");
    }
  });
});

describe("private API responses", () => {
  it("disables shared and browser caching for successes and errors", () => {
    for (const response of [jsonResponse({ value: "synthetic private content" }), apiError("database_unavailable", 503)]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("vary")).toBe("Cookie, Origin");
    }
  });
});
