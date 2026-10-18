/* eslint-disable @typescript-eslint/no-require-imports -- This is a CommonJS one-off benchmark runner. */
const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

async function waitForServer(url) {
  let lastStatus = "no response";
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}: ${(await response.text()).slice(0, 300).replace(/\\s+/g, " ")}`;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Local Next.js server did not become ready at ${url} (${lastStatus})`);
}

async function main() {
  const configPath = "next.config.ts";
  const tsconfigPath = "tsconfig.json";
  const originalConfig = fs.readFileSync(configPath, "utf8");
  const originalTsconfig = fs.readFileSync(tsconfigPath, "utf8");
  const configMarker = "  agentRules: false,";
  if (!originalConfig.includes(configMarker)) throw new Error("Could not find expected temporary distDir insertion point in next.config.ts");
  fs.writeFileSync(configPath, originalConfig.replace(configMarker, `${configMarker}\n  distDir: ".tmp-workspace/m4-next-dist",`));

  let server;
  let browser;
  try {
    const url = "http://127.0.0.1:3101/embedding-feasibility";
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3101"], {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: true,
    });
    server.on("error", (error) => console.error(`next-server: ${error.message}`));
    browser = await chromium.launchPersistentContext(".tmp-workspace/m4-browser-profile", {
      headless: true,
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU"],
    });
    const page = await browser.newPage();
    const modelDownloads = new Map();
    const runs = {};
    page.on("console", (message) => console.log(`console:${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => console.log(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("huggingface.co") || url.includes(".hf.co")) {
        const headers = response.headers();
        const parsed = new URL(url);
        modelDownloads.set(`${parsed.hostname}${parsed.pathname}`, {
          status: response.status(),
          contentLength: headers["content-length"] ?? null,
          transferEncoding: headers["transfer-encoding"] ?? null,
          contentType: headers["content-type"] ?? null,
        });
      }
    });
    await waitForServer(url);
    await page.goto(url, { waitUntil: "networkidle" });
    console.log(`webgpu adapter: ${JSON.stringify(await page.evaluate(async () => {
      if (!navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter();
      return adapter ? { info: adapter.info?.toJSON?.() ?? adapter.info, features: [...adapter.features], limits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } } : null;
    }))}`);

    const cases = process.argv.slice(2).length
      ? process.argv.slice(2).map((value) => value.split(":"))
      : [["webgpu", "q4"], ["webgpu", "q8"]];
    const syntheticArg = process.argv.slice(2).find((value) => value.startsWith("synthetic"));
    if (syntheticArg) {
      const enriched = syntheticArg.endsWith("-enriched");
      const candidate = syntheticArg.startsWith("synthetic-bge") ? "bge-small-en-v1.5"
        : syntheticArg.startsWith("synthetic-arctic") ? "snowflake-arctic-embed-s" : "gemma";
      const backend = syntheticArg.endsWith("-wasm") ? "wasm" : "webgpu";
      const buttonName = candidate === "bge-small-en-v1.5" ? (backend === "wasm" ? "Probe BGE q4 WASM" : enriched ? "Run BGE enriched q4 artifact" : "Run BGE q4 artifact")
        : candidate === "snowflake-arctic-embed-s" ? (backend === "wasm" ? "Probe Arctic q4 WASM" : "Run Arctic q4 artifact")
          : enriched ? "Run synthetic Gemma enriched artifact" : "Run synthetic Gemma q4 artifact";
      await page.getByRole("button", { name: buttonName }).click();
      try {
        await page.getByRole("status").filter({ hasText: "Completed." }).waitFor({ timeout: 600000 });
      } catch {
        const failure = await page.getByRole("status").textContent();
        if (failure?.startsWith("Failed:")) {
          console.log(`${candidate} q4 ${backend} failure: ${failure}`);
          fs.writeFileSync(`.tmp-workspace/embedding-benchmark/probe-${candidate}-q4-${backend}-failure.txt`, failure);
          await browser.close();
          return;
        }
        throw new Error(`${candidate} q4 ${backend} timed out: ${failure}`);
      }
      const result = JSON.parse(await page.locator("pre").last().textContent() || "null");
      const outputDir = ".tmp-workspace/embedding-benchmark";
      fs.mkdirSync(outputDir, { recursive: true });
      const artifactName = candidate === "gemma" ? `gemma2-q4-${backend}-${enriched ? "enriched" : "source"}` : `${candidate}-q4-${backend}${enriched ? "-enriched" : ""}`;
      const dimensions = candidate === "gemma" ? [768, 512, 256, 128] : [result.dimension];
      const outputPath = `${outputDir}/evaluation-${artifactName}.json`;
      fs.writeFileSync(outputPath, JSON.stringify({
        schemaVersion: 1,
        fixture: { documentCount: result.documentCount, queryCount: result.queryCount, documentDimensions: dimensions, queryDimensions: dimensions },
        ...result,
      }));
      console.log(`Synthetic evaluation artifact saved: ${outputPath}`);
      console.log(`Synthetic benchmark summary: ${JSON.stringify({ backend: result.backend, dtype: result.dtype, documentCount: result.documentCount, queryCount: result.queryCount, elapsedMs: result.elapsedMs, vectorsPerSecond: result.vectorsPerSecond, initializationMs: result.initializationMs, modelLoadMs: result.modelLoadMs, queryWarmSamplesMs: result.queryWarmSamplesMs, allFinite: result.allFinite })}`);
      console.log(`Observed HF response metadata: ${JSON.stringify([...modelDownloads])}`);
      await browser.close();
      return;
    }
    for (const [backend, dtype] of cases) {
      console.log(`Starting ${dtype} ${backend}`);
      const button = dtype === "q8" && backend === "wasm" ? "Run q8 WASM fallback"
        : dtype === "fp32" ? "Run fp32 WebGPU reference"
          : `Run ${dtype} ${backend.toUpperCase()}`;
      await page.getByRole("button", { name: button }).click();
      try {
        await page.getByRole("status").filter({ hasText: "Completed." }).waitFor({ timeout: 600000 });
      } catch {
        const status = await page.getByRole("status").textContent();
        console.log(`${dtype} ${backend} status: ${status}`);
        if (status?.startsWith("Failed:")) continue;
        throw new Error(`${dtype} ${backend} timed out with status ${status}`);
      }
      const result = JSON.parse(await page.locator("pre").last().textContent() || "null");
      runs[`${backend}-${dtype}`] = result;
      const { vectors, ...summary } = result;
      console.log(`${dtype} ${backend} result: ${JSON.stringify(summary)}`);
      console.log(`${dtype} ${backend} observed HF response metadata: ${JSON.stringify([...modelDownloads])}`);
    }
    if (runs["webgpu-q4"] && runs["webgpu-q8"]) {
      const cosine = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
      console.log(`same-backend cross-dtype corresponding-vector cosine: ${JSON.stringify(runs["webgpu-q4"].vectors.map((vector, i) => cosine(vector, runs["webgpu-q8"].vectors[i])))}`);
      console.log(`same-backend q4/q8 reference cosine score deltas: ${JSON.stringify(runs["webgpu-q8"].cosineScores.map((score, i) => score - runs["webgpu-q4"].cosineScores[i]))}`);
    }
    if (runs["webgpu-fp32"]) {
      const cosine = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
      for (const dtype of ["q4", "q8"]) {
        const candidate = runs[`webgpu-${dtype}`];
        if (!candidate) continue;
        const vectorCosines = candidate.vectors.map((vector, i) => cosine(vector, runs["webgpu-fp32"].vectors[i]));
        const rankingAgreement = candidate.ranking.filter((docIndex, rank) => runs["webgpu-fp32"].ranking[rank] === docIndex).length;
        console.log(`${dtype}/fp32 corresponding-vector cosine (query then four docs): ${JSON.stringify(vectorCosines)}`);
        console.log(`${dtype}/fp32 four-document rank agreement: ${rankingAgreement}/4; top-4 identical: ${JSON.stringify(candidate.ranking) === JSON.stringify(runs["webgpu-fp32"].ranking)}`);
      }
    }
    await browser.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    fs.writeFileSync(configPath, originalConfig);
    fs.writeFileSync(tsconfigPath, originalTsconfig);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
