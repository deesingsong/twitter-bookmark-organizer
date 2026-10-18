import type { ZodType } from "zod";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie, Origin",
};

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: PRIVATE_HEADERS });
}

export function apiError(code: string, status: number, fields?: string[]): Response {
  return jsonResponse(fields ? { error: code, fields } : { error: code }, status);
}

export type JsonBodyResult<T> = { ok: true; data: T } | { ok: false; response: Response };

export async function readJsonRequest<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes: number,
): Promise<JsonBodyResult<T>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, response: apiError("json_content_type_required", 415) };
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  // An explicitly opaque/invalid Origin must not fall back to Referer.
  const source = origin === null ? referer : origin;
  if (!source) return { ok: false, response: apiError("same_origin_required", 403) };
  try {
    const sourceUrl = new URL(source);
    const targetUrl = new URL(request.url);
    const host = request.headers.get("host");
    // Next.js supplies the request protocol; extra forwarded headers cannot
    // replace the target host or protocol for this browser-only API.
    const expectedOrigin = host ? new URL(`${targetUrl.protocol}//${host}`).origin : targetUrl.origin;
    if (!["http:", "https:"].includes(sourceUrl.protocol)
      || (origin !== null && origin !== sourceUrl.origin)
      || sourceUrl.origin !== expectedOrigin) {
      return { ok: false, response: apiError("same_origin_required", 403) };
    }
  } catch {
    return { ok: false, response: apiError("same_origin_required", 403) };
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return { ok: false, response: apiError("same_origin_required", 403) };
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return { ok: false, response: apiError("invalid_content_length", 400) };
    }
    if (declared > maxBytes) return { ok: false, response: apiError("request_too_large", 413) };
  }
  if (!request.body) return { ok: false, response: apiError("empty_request_body", 400) };

  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, response: apiError("request_too_large", 413) };
      }
      parts.push(value);
    }
  } catch {
    return { ok: false, response: apiError("invalid_request_body", 400) };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return { ok: false, response: apiError("invalid_json", 400) };
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "body"))];
    return { ok: false, response: apiError("invalid_request", 422, fields) };
  }
  return { ok: true, data: parsed.data };
}
