import { AutoConfig, AutoModel, AutoTokenizer, env, matmul } from "@huggingface/transformers";

const modelId = "onnx-community/embeddinggemma-2-ONNX";
const revision = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

type SyntheticDocument = { id: string; text: string; quotedText?: string; note?: string; tags?: string[] };
type SyntheticQuery = { id: string; kind: string; query: string; context?: string; language?: string };
type EmbeddingRequest = {
  backend: "webgpu" | "wasm";
  dtype: "q4" | "q8" | "fp32";
} & (
  | { mode: "synthetic"; documents: SyntheticDocument[]; queries: SyntheticQuery[]; enriched?: boolean }
  | { mode?: "single"; documents: string[]; query: string }
);

self.onmessage = async (event: MessageEvent<EmbeddingRequest>) => {
  const { backend, dtype } = event.data;
  try {
    env.allowRemoteModels = true;
    const initializationStart = performance.now();
    const config = await AutoConfig.from_pretrained(modelId, { revision, progress_callback: (p) => self.postMessage({ type: "progress", value: p }) });
    const configRecord = config as unknown as Record<string, unknown>;
    const optionalVisionRemoved = Object.hasOwn(configRecord, "vision_config");
    const optionalAudioRemoved = Object.hasOwn(configRecord, "audio_config");
    configRecord.vision_config = null;
    configRecord.audio_config = null;
    const architectures = Array.isArray(configRecord.architectures) ? configRecord.architectures.filter((x): x is string => typeof x === "string") : [];
    if (config.model_type !== "embedding_gemma2" || architectures.length !== 1 || architectures[0] !== "EmbeddingGemma2Model"
      || configRecord.vision_config !== null || configRecord.audio_config !== null) {
      throw new Error(`Unexpected text-only model config: ${config.model_type} / ${architectures.join(",")}`);
    }
    const tokenizer = await AutoTokenizer.from_pretrained(modelId, { revision, progress_callback: (p) => self.postMessage({ type: "progress", value: p }) });
    const loadStart = performance.now();
    const model = await AutoModel.from_pretrained(modelId, {
      revision,
      dtype,
      device: backend,
      config,
      progress_callback: (p) => self.postMessage({ type: "progress", value: p }),
    });
    const loadMs = performance.now() - loadStart;
    const initializationMs = performance.now() - initializationStart;

    if (event.data.mode === "synthetic") {
      const docs = event.data.documents;
      const queries = event.data.queries;
      const enriched = event.data.enriched;
      const encode = async (texts: string[]) => {
        const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: 2048 });
        const output = await model(inputs);
        const vectors = output.sentence_embedding.tolist() as number[][];
        if (!vectors.every((vector) => vector.length === 768 && vector.every(Number.isFinite))) {
          throw new Error("Synthetic embedding batch had invalid dimensions or non-finite values.");
        }
        return vectors;
      };
      const documents: number[][] = [];
      const queriesOutput: number[][] = [];
      const started = performance.now();
      for (let offset = 0; offset < docs.length; offset += 8) {
        const batch = docs.slice(offset, offset + 8).map(({ text, quotedText, note, tags }) => {
          const enrichedText = enriched
            ? [text, quotedText ? `Quoted text: ${quotedText}` : "", note ? `Owner note: ${note}` : "", tags?.length ? `Owner tags: ${tags.join(", ")}` : ""].filter(Boolean).join("\n")
            : text;
          return `title: none | text: ${enrichedText}`;
        });
        documents.push(...await encode(batch));
      }
      for (let offset = 0; offset < queries.length; offset += 8) {
        const batch = queries.slice(offset, offset + 8).map(({ query }) => `task: search result | query: ${query}`);
        queriesOutput.push(...await encode(batch));
      }
      const elapsedMs = performance.now() - started;
      const representativeQuery = `task: search result | query: ${queries[0]?.query ?? "semantic retrieval benchmark"}`;
      const queryWarmSamplesMs: number[] = [];
      for (let iteration = 0; iteration < 5; iteration++) {
        const queryStart = performance.now();
        await encode([representativeQuery]);
        queryWarmSamplesMs.push(performance.now() - queryStart);
      }
      const vectorCount = documents.length + queriesOutput.length;
      self.postMessage({ type: "result", value: {
        mode: "synthetic",
        contentMode: event.data.enriched ? "source-plus-quoted-text-note-tags" : "source-text-only",
        backend,
        dtype,
        dimension: 768,
        documentCount: documents.length,
        queryCount: queriesOutput.length,
        elapsedMs,
        initializationMs,
        modelLoadMs: loadMs,
        queryWarmSamplesMs,
        vectorsPerSecond: vectorCount / (elapsedMs / 1000),
        allFinite: [...documents, ...queriesOutput].every((vector) => vector.length === 768 && vector.every(Number.isFinite)),
        documents: docs.map((document, index) => ({ id: document.id, vector: documents[index] })),
        queries: queries.map((query, index) => ({ id: query.id, kind: query.kind, context: query.context, language: query.language, vector: queriesOutput[index] })),
        model: { id: modelId, revision, transformersJs: "4.3.1", queryPrefix: "task: search result | query: ", documentPrefix: "title: none | text: ", configVisionAudioNull: true },
      } });
      return;
    }
    // EmbeddingGemma requires asymmetric retrieval prefixes as specified by its model card.
    const inputs = tokenizer([
      `task: search result | query: ${event.data.query}`,
      ...event.data.documents.map((text) => `title: none | text: ${text}`),
    ], { padding: true, truncation: true, max_length: 2048 });
    const firstInferenceStart = performance.now();
    let { sentence_embedding: embeddings } = await model(inputs);
    const firstInferenceMs = performance.now() - firstInferenceStart;
    const warmSamplesMs: number[] = [];
    for (let iteration = 0; iteration < 4; iteration++) {
      const inferenceStart = performance.now();
      ({ sentence_embedding: embeddings } = await model(inputs));
      warmSamplesMs.push(performance.now() - inferenceStart);
    }
    const warmSorted = [...warmSamplesMs].sort((a, b) => a - b);
    const warmMedianMs = warmSorted[Math.floor(warmSorted.length / 2)];
    const warmP95Ms = warmSorted[Math.ceil(warmSorted.length * 0.95) - 1];
    const vectors = embeddings.tolist() as number[][];
    const scores = (await matmul(embeddings, embeddings.transpose(1, 0))).tolist() as number[][];
    const cosineScores = scores[0].slice(1);
    const ranking = cosineScores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score || a.index - b.index).map(({ index }) => index + 1);
    const norms = vectors.map((vector) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)));
    const allFinite = vectors.every((vector) => vector.length === 768 && vector.every(Number.isFinite)) && cosineScores.every(Number.isFinite);
    if (!allFinite) throw new Error("Embedding output had invalid dimensions or non-finite values.");
    self.postMessage({
      type: "result",
      value: {
        backend,
        dtype,
        dimension: vectors[0].length,
        norms,
        selfSimilarities: scores.map((row, index) => row[index]),
        allFinite,
        vectors,
        cosineScores,
        ranking,
        expectedBestRank: ranking.indexOf(2) + 1,
        loadMs,
        initializationMs,
        firstInferenceMs,
        warmSamplesMs,
        warmMedianMs,
        warmP95Ms,
        config: { modelType: config.model_type, architectures, optionalVisionRemoved, optionalAudioRemoved },
      },
    });
  } catch (error) {
    self.postMessage({ type: "error", value: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
};
