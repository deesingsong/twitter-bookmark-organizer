"use client";

import { useRef, useState } from "react";
import { SYNTHETIC_SEMANTIC_DOCUMENTS, SYNTHETIC_SEMANTIC_QUERIES } from "@/lib/search/evaluation/semantic/fixtures";

type RunResult = {
  backend: string;
  dimension: number;
  norm: number;
  cosineScores: number[];
  ranking: number[];
  expectedBestRank: number;
  loadMs: number;
  inferenceMs: number;
  config: { modelType: string | null; architectures: string[]; optionalVisionRemoved: boolean; optionalAudioRemoved: boolean };
};

const documents = [
  "Venus is often called Earth's twin because of its similar size and proximity.",
  "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
  "Jupiter, the largest planet in our solar system, has a prominent red spot.",
  "Saturn, famous for its rings, is sometimes mistaken for the Red Planet.",
];
const query = "Which planet is known as the Red Planet?";

export default function FeasibilityHarness() {
  const worker = useRef<Worker | null>(null);
  const [state, setState] = useState("Ready. Each run downloads/caches the pinned q4 model from Hugging Face.");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);

  function run(backend: "webgpu" | "wasm", dtype: "q4" | "q8" | "fp32" = "q4") {
    worker.current?.terminate();
    const instance = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.current = instance;
    setResult(null);
    setProgress("");
    setState(`Running ${dtype} ${backend.toUpperCase()}…`);
    instance.onmessage = (event: MessageEvent<{ type: string; value?: unknown }>) => {
      if (event.data.type === "progress") setProgress(String(event.data.value));
      if (event.data.type === "result") {
        setResult(event.data.value as RunResult);
        setState("Completed.");
      }
      if (event.data.type === "error") setState(`Failed: ${String(event.data.value)}`);
    };
    instance.postMessage({ backend, dtype, documents, query });
  }

  function runSyntheticBatch(enriched = false, candidate: "gemma" | "bge-small-en-v1.5" | "snowflake-arctic-embed-s" = "gemma", backend: "webgpu" | "wasm" = "webgpu") {
    worker.current?.terminate();
    const instance = candidate === "gemma"
      ? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
      : new Worker(new URL("./alternative-worker.ts", import.meta.url), { type: "module" });
    worker.current = instance;
    setResult(null);
    setProgress("");
    setState(`Running ${candidate} q4 WebGPU synthetic ${enriched ? "enriched" : "source-text"} batch…`);
    instance.onmessage = (event: MessageEvent<{ type: string; value?: unknown }>) => {
      if (event.data.type === "progress") setProgress(String(event.data.value));
      if (event.data.type === "result") {
        setResult(event.data.value as RunResult);
        setState("Completed.");
      }
      if (event.data.type === "error") setState(`Failed: ${String(event.data.value)}`);
    };
    instance.postMessage({
      mode: "synthetic",
      backend,
      dtype: "q4",
      candidate,
      enriched,
      documents: SYNTHETIC_SEMANTIC_DOCUMENTS.map(({ id, text, quotedText, note, tags }) => ({ id, text, quotedText, note, tags })),
      queries: SYNTHETIC_SEMANTIC_QUERIES.map(({ id, kind, query, context, language }) => ({ id, kind, query, context, language })),
    });
  }

  return (
    <main style={{ maxWidth: 900, margin: "40px auto", padding: 24, fontFamily: "system-ui", color: "#17202a" }}>
      <h1>EmbeddingGemma 2 q4 feasibility</h1>
      <p>Isolated browser-only probe. It uses a pinned model commit and never calls the app API or database.</p>
      <p><strong>Reference:</strong> ONNX Community EmbeddingGemma 2 model card example; expected top result is Mars (document 2), score ≈0.854.</p>
      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={() => run("webgpu")}>Run q4 WebGPU</button>
        <button onClick={() => run("webgpu", "q8")}>Run q8 WebGPU</button>
        <button onClick={() => run("webgpu", "fp32")}>Run fp32 WebGPU reference</button>
        <button onClick={() => runSyntheticBatch()}>Run synthetic Gemma q4 artifact</button>
        <button onClick={() => runSyntheticBatch(true)}>Run synthetic Gemma enriched artifact</button>
        <button onClick={() => runSyntheticBatch(false, "bge-small-en-v1.5")}>Run BGE q4 artifact</button>
        <button onClick={() => runSyntheticBatch(true, "bge-small-en-v1.5")}>Run BGE enriched q4 artifact</button>
        <button onClick={() => runSyntheticBatch(false, "snowflake-arctic-embed-s")}>Run Arctic q4 artifact</button>
        <button onClick={() => runSyntheticBatch(false, "bge-small-en-v1.5", "wasm")}>Probe BGE q4 WASM</button>
        <button onClick={() => runSyntheticBatch(false, "snowflake-arctic-embed-s", "wasm")}>Probe Arctic q4 WASM</button>
        <button onClick={() => run("wasm")}>Run q4 WASM</button>
        <button onClick={() => run("wasm", "q8")}>Run q8 WASM fallback</button>
      </div>
      <p role="status">{state}</p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{progress}</pre>
      {result && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#f3f5f7", padding: 16 }}>{JSON.stringify(result, null, 2)}</pre>}
      <h2>Reference inputs</h2>
      <p>{query}</p>
      <ol>{documents.map((text) => <li key={text}>{text}</li>)}</ol>
    </main>
  );
}
