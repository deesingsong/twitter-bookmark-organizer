import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_CONTRACT } from "./contracts";
import { embeddingDocumentHash, prepareEmbeddingDocument, prepareEmbeddingQuery } from "./preprocess";
import type { EmbeddingWorkerRequest, EmbeddingWorkerResponse } from "./worker";

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), encode: vi.fn(), dispose: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({
  env: { backends: { onnx: { wasm: {} } } }, LogLevel: { NONE: 50 }, pipeline: mocks.pipeline,
}));

const vector = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
let receive: (event: MessageEvent<EmbeddingWorkerRequest>) => void;
let responses: EmbeddingWorkerResponse[];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  responses = [];
  mocks.encode.mockReset().mockResolvedValue({ tolist: () => [vector], dispose: vi.fn() });
  mocks.dispose.mockReset().mockResolvedValue(undefined);
  mocks.pipeline.mockReset().mockResolvedValue(Object.assign(mocks.encode, { dispose: mocks.dispose }));
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("self", {
    postMessage: (message: EmbeddingWorkerResponse) => responses.push(message),
    addEventListener: (_type: string, callback: typeof receive) => { receive = callback; },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function send(request: EmbeddingWorkerRequest) {
  receive({ data: request } as MessageEvent<EmbeddingWorkerRequest>);
  await vi.waitFor(() => expect(responses.some(item => item.type !== "status" && item.id === request.id)).toBe(true));
  return responses.find(item => item.type !== "status" && item.id === request.id)!;
}

describe("production local embedding worker", () => {
  it("lazily reuses one pinned WASM model with exact document/query preprocessing", async () => {
    await import("./worker");
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(await send({ type: "initialize", id: 1 })).toMatchObject({ type: "result", backend: "wasm", vector: null });
    const document = { text: " Synthetic passage. ", quotedText: "Synthetic quote.", note: "Synthetic note.", tags: ["z", "a"] };
    expect(await send({ type: "document", id: 2, document, contentHash: await embeddingDocumentHash(document) }))
      .toMatchObject({ type: "result", vector });
    await send({ type: "query", id: 3, query: "synthetic concept" });
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
    expect(mocks.pipeline).toHaveBeenCalledWith("feature-extraction", EMBEDDING_CONTRACT.modelId, expect.objectContaining({
      revision: EMBEDDING_CONTRACT.modelRevision, dtype: "q4", device: "wasm",
    }));
    expect(mocks.encode).toHaveBeenNthCalledWith(1, prepareEmbeddingDocument(document), { pooling: "cls", normalize: true });
    expect(mocks.encode).toHaveBeenNthCalledWith(2, prepareEmbeddingQuery("synthetic concept"), { pooling: "cls", normalize: true });
  });

  it("tries WebGPU first and visibly falls back when initialization fails", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    mocks.pipeline.mockRejectedValueOnce(new Error("Synthetic GPU unavailable"));
    await import("./worker");
    expect(await send({ type: "initialize", id: 1 })).toMatchObject({ backend: "wasm" });
    expect(mocks.pipeline.mock.calls.map(call => call[2].device)).toEqual(["webgpu", "wasm"]);
    expect(responses).toContainEqual({ type: "status", status: { phase: "ready", backend: "wasm", downloadPercent: null, fallback: true } });
  });

  it("recovers from a lost GPU during inference using the same WASM contract", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    mocks.encode.mockRejectedValueOnce(new Error("Synthetic device loss"));
    await import("./worker");
    expect(await send({ type: "query", id: 1, query: "synthetic query" })).toMatchObject({ type: "result", vector, backend: "wasm" });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.pipeline.mock.calls.map(call => call[2].device)).toEqual(["webgpu", "wasm"]);
    expect(mocks.encode.mock.calls[0]).toEqual(mocks.encode.mock.calls[1]);
  });

  it("rejects a mismatched content hash before model loading", async () => {
    await import("./worker");
    expect(await send({ type: "document", id: 1, document: { text: "Synthetic passage" }, contentHash: "0".repeat(64) }))
      .toEqual({ type: "error", id: 1, errorCode: "embedding_failed" });
    expect(mocks.pipeline).not.toHaveBeenCalled();
  });

  it("returns only a fixed error code for a failed model download", async () => {
    mocks.pipeline.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_CONTENT must not be returned"));
    await import("./worker");
    expect(await send({ type: "initialize", id: 1 })).toEqual({ type: "error", id: 1, errorCode: "model_load_failed" });
    expect(JSON.stringify(responses)).not.toContain("SYNTHETIC_PRIVATE_CONTENT");
  });

  it.each([Array(383).fill(1), Array(384).fill(0), [...Array(383).fill(1), Number.NaN]].map(invalid => ({ invalid })))(
    "rejects invalid inference output", async ({ invalid }) => {
      mocks.encode.mockResolvedValue({ tolist: () => [invalid], dispose: vi.fn() });
      await import("./worker");
      expect(await send({ type: "query", id: 1, query: "synthetic query" }))
        .toEqual({ type: "error", id: 1, errorCode: "embedding_failed" });
    },
  );
});
