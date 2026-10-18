import { pipeline, env } from "@huggingface/transformers";
import { prepareEmbeddingDocument } from "@/lib/embeddings/preprocess";

type Candidate = "bge-small-en-v1.5" | "snowflake-arctic-embed-s";
type AlternativeDocument = { id: string; text: string; quotedText?: string; note?: string; tags?: string[] };
type AlternativeQuery = { id: string; kind: string; query: string; context?: string; language?: string };
type AlternativeRequest = {
  candidate: Candidate;
  backend?: "webgpu" | "wasm";
  documents: AlternativeDocument[];
  queries: AlternativeQuery[];
  enriched?: boolean;
};

const candidates: Record<Candidate, { id: string; revision: string; queryPrefix: string; dimensions: number }> = {
  "bge-small-en-v1.5": {
    id: "onnx-community/bge-small-en-v1.5-ONNX",
    revision: "4a9a46c7b88fa408e650a571a1800243f26309bd",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    dimensions: 384,
  },
  "snowflake-arctic-embed-s": {
    id: "Snowflake/snowflake-arctic-embed-s",
    revision: "e596f507467533e48a2e17c007f0e1dacc837b33",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    dimensions: 384,
  },
};

self.onmessage = async (event: MessageEvent<AlternativeRequest>) => {
  try {
    const candidate = event.data.candidate as Candidate;
    const details = candidates[candidate];
    if (!details) throw new Error(`Unknown alternative embedding candidate: ${candidate}`);
    env.allowRemoteModels = true;
    const initializationStart = performance.now();
    const backend = (event.data.backend ?? "webgpu") as "webgpu" | "wasm";
    const extractor = await pipeline("feature-extraction", details.id, {
      revision: details.revision,
      dtype: "q4",
      device: backend,
      progress_callback: (progress) => self.postMessage({ type: "progress", value: progress }),
    });
    const initializationMs = performance.now() - initializationStart;
    const docs = event.data.documents;
    const queries = event.data.queries;
    const encode = async (texts: string[]) => {
      const output = await extractor(texts, { pooling: "cls", normalize: true });
      const vectors = output.tolist() as number[][];
      if (!vectors.every((vector) => vector.length === details.dimensions && vector.every(Number.isFinite))) {
        throw new Error(`Expected finite ${details.dimensions}-dimensional CLS embeddings.`);
      }
      return vectors;
    };
    const documents: number[][] = [];
    const queryVectors: number[][] = [];
    const started = performance.now();
    for (let offset = 0; offset < docs.length; offset += 8) {
      documents.push(...await encode(docs.slice(offset, offset + 8).map(({ text, quotedText, note, tags }) => prepareEmbeddingDocument(
        event.data.enriched ? { text, quotedText, note, tags } : { text },
      ))));
    }
    for (let offset = 0; offset < queries.length; offset += 8) {
      queryVectors.push(...await encode(queries.slice(offset, offset + 8).map(({ query }) => `${details.queryPrefix}${query}`)));
    }
    const elapsedMs = performance.now() - started;
    const representative = `${details.queryPrefix}${queries[0]?.query ?? "semantic retrieval benchmark"}`;
    const queryWarmSamplesMs: number[] = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      const queryStart = performance.now();
      await encode([representative]);
      queryWarmSamplesMs.push(performance.now() - queryStart);
    }
    await extractor.dispose();
    self.postMessage({ type: "result", value: {
      mode: "synthetic",
      contentMode: event.data.enriched ? "source-plus-quoted-text-note-tags" : "source-text-only",
      candidate,
      backend,
      dtype: "q4",
      dimension: details.dimensions,
      documentCount: docs.length,
      queryCount: queries.length,
      elapsedMs,
      initializationMs,
      vectorsPerSecond: (docs.length + queryVectors.length) / (elapsedMs / 1000),
      queryWarmSamplesMs,
      allFinite: [...documents, ...queryVectors].every((vector) => vector.length === details.dimensions && vector.every(Number.isFinite)),
      documents: docs.map((document, index) => ({ id: document.id, vector: documents[index] })),
      queries: queries.map((query, index) => ({ id: query.id, kind: query.kind, context: query.context, language: query.language, vector: queryVectors[index] })),
      model: { id: details.id, revision: details.revision, transformersJs: "4.3.1", pooling: "cls", normalized: true, queryPrefix: details.queryPrefix, documentPrefix: "" },
    } });
  } catch (error) {
    self.postMessage({ type: "error", value: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
};
