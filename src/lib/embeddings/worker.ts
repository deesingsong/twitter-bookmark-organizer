import { env, LogLevel, pipeline, type FeatureExtractionPipeline, type ProgressInfo } from "@huggingface/transformers";
import { EMBEDDING_CONTRACT, validateEmbeddingVector, type EmbeddingDocumentInput } from "./contracts";
import { hashEmbeddingDocument, prepareEmbeddingDocument, prepareEmbeddingQuery } from "./preprocess";

export type EmbeddingBackend = "webgpu" | "wasm";
export type EmbeddingErrorCode = "model_unavailable" | "model_load_failed" | "embedding_failed" | "unsupported_runtime" | "indexing_cancelled";
export type EmbeddingModelStatus = {
  phase: "idle" | "loading" | "ready" | "error";
  backend: EmbeddingBackend | null;
  downloadPercent: number | null;
  fallback: boolean;
};
export type EmbeddingWorkerRequest = { id: number } & (
  | { type: "initialize" }
  | { type: "document"; document: EmbeddingDocumentInput; contentHash: string }
  | { type: "query"; query: string }
);
export type EmbeddingWorkerResponse =
  | { type: "status"; status: EmbeddingModelStatus }
  | { type: "result"; id: number; backend: EmbeddingBackend; vector: number[] | null }
  | { type: "error"; id: number; errorCode: EmbeddingErrorCode };

// A dedicated worker owns one model. Neither inputs nor inference errors are logged.
env.allowLocalModels = false;
env.logLevel = LogLevel.NONE;
env.backends.onnx.logLevel = "fatal";
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

const scope = self as unknown as {
  postMessage(message: EmbeddingWorkerResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<EmbeddingWorkerRequest>) => void): void;
};
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let backend: EmbeddingBackend = "wasm";
let fallback = false;
let lastPercent: number | null = null;

function report(phase: EmbeddingModelStatus["phase"], downloadPercent: number | null = null) {
  scope.postMessage({ type: "status", status: { phase, backend, downloadPercent, fallback } });
}

function progress(info: ProgressInfo) {
  // Per-file percentages are not an honest percentage for the entire model.
  if (info.status !== "progress_total" || !Number.isFinite(info.progress)) return;
  const percent = Math.max(0, Math.min(100, Math.floor(info.progress)));
  if (percent !== lastPercent) {
    lastPercent = percent;
    report("loading", percent);
  }
}

async function load(device: EmbeddingBackend): Promise<FeatureExtractionPipeline> {
  backend = device;
  lastPercent = null;
  report("loading");
  const extractor = await pipeline("feature-extraction", EMBEDDING_CONTRACT.modelId, {
    revision: EMBEDDING_CONTRACT.modelRevision,
    dtype: EMBEDDING_CONTRACT.dtype,
    device,
    progress_callback: progress,
  });
  report("ready");
  return extractor;
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      if (typeof navigator !== "undefined" && "gpu" in navigator) {
        try {
          return await load("webgpu");
        } catch {
          fallback = true;
        }
      }
      return load("wasm");
    })();
  }
  try {
    return await extractorPromise;
  } catch {
    extractorPromise = null;
    report("error");
    throw new WorkerFailure("model_load_failed");
  }
}

class WorkerFailure extends Error {
  constructor(readonly code: EmbeddingErrorCode) { super(code); }
}

async function infer(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const encode = async (model: FeatureExtractionPipeline) => {
    const output = await model(text, {
      pooling: EMBEDDING_CONTRACT.pooling,
      normalize: EMBEDDING_CONTRACT.normalize,
    });
    try {
      const rows: unknown = output.tolist();
      if (!Array.isArray(rows) || rows.length !== 1) throw new WorkerFailure("embedding_failed");
      return validateEmbeddingVector(rows[0]);
    } finally {
      output.dispose();
    }
  };
  try {
    return await encode(extractor);
  } catch {
    // A GPU can become unavailable after initialization (for example, device loss).
    if (backend === "webgpu") {
      fallback = true;
      await extractor.dispose().catch(() => undefined);
      extractorPromise = load("wasm");
      try {
        return await encode(await getExtractor());
      } catch (error) {
        if (error instanceof WorkerFailure) throw error;
      }
    }
    throw new WorkerFailure("embedding_failed");
  }
}

async function handle(request: EmbeddingWorkerRequest) {
  try {
    let vector: number[] | null = null;
    if (request.type === "initialize") {
      await getExtractor();
    } else if (request.type === "document") {
      const text = prepareEmbeddingDocument(request.document);
      if (!text || await hashEmbeddingDocument(text) !== request.contentHash) {
        throw new WorkerFailure("embedding_failed");
      }
      vector = await infer(text);
    } else if (request.type === "query") {
      vector = await infer(prepareEmbeddingQuery(request.query));
    } else {
      throw new WorkerFailure("embedding_failed");
    }
    scope.postMessage({ type: "result", id: request.id, vector, backend });
  } catch (error) {
    scope.postMessage({ type: "error", id: request.id, errorCode: error instanceof WorkerFailure ? error.code : "embedding_failed" });
  }
}

// ONNX sessions are used sequentially even when query and indexing calls overlap.
let pending = Promise.resolve();
scope.addEventListener("message", (event) => {
  pending = pending.then(() => handle(event.data));
});
