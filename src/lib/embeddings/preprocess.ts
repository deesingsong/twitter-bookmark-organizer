import { EMBEDDING_CONTRACT, type EmbeddingDocumentInput } from "./contracts";

/** Preserve interior text; normalize line endings and field boundary whitespace. */
function prepareField(value: string | null | undefined): string {
  return value?.replace(/\r\n?/g, "\n").trim() ?? "";
}

/**
 * The evaluated enriched layout: unlabeled primary text, then labeled context.
 * Tags are sorted by code point and empty fields omitted, so database row order
 * cannot change the model input or its hash. Duplicate tags are removed.
 * No identity, author, date, collection, or relevance metadata is read.
 */
export function prepareEmbeddingDocument(input: EmbeddingDocumentInput): string {
  const text = prepareField(input.text);
  const quotedText = prepareField(input.quotedText);
  const note = prepareField(input.note);
  const tags = [...new Set(input.tags?.map(prepareField).filter(Boolean) ?? [])]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .join(", ");

  return [
    text,
    quotedText ? `Quoted text: ${quotedText}` : "",
    note ? `Owner note: ${note}` : "",
    tags ? `Owner tags: ${tags}` : "",
  ].filter(Boolean).join("\n");
}

/** Query text is otherwise verbatim; request validation belongs at the boundary. */
export function prepareEmbeddingQuery(query: string): string {
  return `${EMBEDDING_CONTRACT.queryPrefix}${query}`;
}

/**
 * SHA-256 over UTF-8 JSON [preprocessingVersion, finalPreparedDocument].
 * The explicit tuple encoding separates version and text without delimiter
 * ambiguity. Model identity is stored separately in the embedding contract.
 */
export async function hashEmbeddingDocument(
  preparedDocument: string,
  preprocessingVersion: string = EMBEDDING_CONTRACT.preprocessingVersion,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([preprocessingVersion, preparedDocument]));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function embeddingDocumentHash(input: EmbeddingDocumentInput): Promise<string> {
  return hashEmbeddingDocument(prepareEmbeddingDocument(input));
}
