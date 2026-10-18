/* eslint-disable @typescript-eslint/no-require-imports -- This is a CommonJS one-off benchmark helper. */
const fs = require("fs");

function readArtifact(path) {
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  if (value.documents.length !== 168 || value.queries.length !== 88 || value.allFinite !== true) {
    throw new Error(`Unexpected or invalid artifact: ${path}`);
  }
  return value;
}

function cosine(left, right) {
  if (left.length !== right.length) throw new Error("Backend vector dimensions differ.");
  let dot = 0;
  for (let i = 0; i < left.length; i++) dot += left[i] * right[i];
  return dot;
}

function main() {
  const [webgpuPath, wasmPath] = process.argv.slice(2);
  if (!webgpuPath || !wasmPath) throw new Error("Usage: node compare-backends.cjs <webgpu.json> <wasm.json>");
  const webgpu = readArtifact(webgpuPath);
  const wasm = readArtifact(wasmPath);
  if (webgpu.model.id !== wasm.model.id || webgpu.model.revision !== wasm.model.revision) throw new Error("Backend artifacts are not from the same model revision.");
  if (webgpu.documents.some((document, index) => document.id !== wasm.documents[index].id)
    || webgpu.queries.some((query, index) => query.id !== wasm.queries[index].id)) throw new Error("Backend fixture order or IDs differ.");

  const vectorPairs = [
    ...webgpu.documents.map((document, index) => [document.vector, wasm.documents[index].vector]),
    ...webgpu.queries.map((query, index) => [query.vector, wasm.queries[index].vector]),
  ];
  const cosines = vectorPairs.map(([left, right]) => cosine(left, right));
  const norms = [...webgpu.documents, ...webgpu.queries].map(({ vector }) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)));
  const wasmNorms = [...wasm.documents, ...wasm.queries].map(({ vector }) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)));
  let exactRankQueries = 0;
  let top1Agreement = 0;
  let top5Overlap = 0;
  let top10Overlap = 0;
  for (let queryIndex = 0; queryIndex < webgpu.queries.length; queryIndex++) {
    const rank = (queryVector, documents) => documents.map((document) => ({ id: document.id, score: cosine(queryVector, document.vector) }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).map(({ id }) => id);
    const gpuRank = rank(webgpu.queries[queryIndex].vector, webgpu.documents);
    const wasmRank = rank(wasm.queries[queryIndex].vector, wasm.documents);
    if (gpuRank.every((id, index) => wasmRank[index] === id)) exactRankQueries++;
    if (gpuRank[0] === wasmRank[0]) top1Agreement++;
    const wasmTop5 = new Set(wasmRank.slice(0, 5));
    top5Overlap += gpuRank.slice(0, 5).filter((id) => wasmTop5.has(id)).length / 5;
    const wasmTop10 = new Set(wasmRank.slice(0, 10));
    top10Overlap += gpuRank.slice(0, 10).filter((id) => wasmTop10.has(id)).length / 10;
  }
  const sorted = [...cosines].sort((a, b) => a - b);
  const summary = {
    model: webgpu.model.id,
    revision: webgpu.model.revision,
    dimensions: webgpu.dimension,
    pairedVectors: vectorPairs.length,
    cosine: { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], mean: cosines.reduce((sum, value) => sum + value, 0) / cosines.length },
    webgpuNormRange: [Math.min(...norms), Math.max(...norms)],
    wasmNormRange: [Math.min(...wasmNorms), Math.max(...wasmNorms)],
    fullRankAgreementQueries: `${exactRankQueries}/${webgpu.queries.length}`,
    top1AgreementQueries: `${top1Agreement}/${webgpu.queries.length}`,
    meanTop5Overlap: top5Overlap / webgpu.queries.length,
    meanTop10Overlap: top10Overlap / webgpu.queries.length,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
