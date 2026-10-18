# Local embedding feasibility and selection

## Recommendation

Select **BAAI BGE-small-en-v1.5 ONNX**, using the immutable Transformers.js-compatible revision `4a9a46c7b88fa408e650a571a1800243f26309bd`, as the first production candidate. Its contract is 384 dimensions, CLS pooling, L2 normalization, no document prefix, and the query prefix `Represent this sentence for searching relevant passages: `. The package tested was `@huggingface/transformers@4.3.1`.

BGE is a conditional selection pending application integration and protected deployment checks. It gives up a small amount of semantic-only quality against Gemma at 512 dimensions, but q4 runs on both desktop WebGPU and WASM, its measured ONNX weights are about 61.3 MB, it matches the existing `vector(384)` column, and its source-only hybrid RRF score is effectively tied with the best Gemma result. Gemma remains a viable future candidate if measured mobile hardware or user experience favors its stronger semantic-only score enough to justify a larger model, WebGPU dependence, and a dimension migration.

Use deterministic enriched document input: primary tweet text as the first block, followed by optional `Quoted text: ...`, `Owner note: ...`, and `Owner tags: ...` lines in that order, omitting absent fields. This matches the preprocessing measured in the evaluation. Do not embed usernames, URLs, IDs, relevance labels, or query metadata. Hash exactly the normalized fields and preprocessing version used for this string. Enrichment improved BGE on the same authored fixture; invalidation must therefore cover edits to every included field, including tag changes.

## Evaluation method

All quality runs use the same **168 invented documents and 88 authored queries**, with relevance judgments held fixed across candidates. The fixture covers conceptual and paraphrase retrieval, lexical and exact-match queries, quotes, owner notes/tags, and four multilingual diagnostic queries. The judgments are author-assigned and the corpus is synthetic; they are evidence for candidate comparison, not an independent quality certification or a claim of multilingual capability.

The local browser used Transformers.js `4.3.1`, pinned model revisions, q4 ONNX, and real Chrome WebGPU without a SwiftShader override. BGE and Arctic also ran in WASM. Gemma output was generated at 768 dimensions and truncated/renormalized for 512, 256, and 128 dimension evaluations. Embedding batches encode eight texts at a time. Timings below are observed local runs; initialization can be warm-cache dependent and is not a mobile benchmark.

| Candidate / backend | Dimensions | Semantic MRR@10 | Semantic nDCG@10 | Source-branch hybrid RRF nDCG@10 |
|---|---:|---:|---:|---:|
| BGE q4 WebGPU, source only | 384 | 0.792 | 0.748 | 0.903 |
| BGE q4 WebGPU, enriched docs | 384 | 0.820 | 0.779 | — |
| BGE q4 WASM, source only | 384 | 0.793 | 0.748 | 0.905 |
| Gemma 2 q4 WebGPU, source only | 768 | 0.798 | 0.758 | 0.904 |
| Gemma 2 q4 WebGPU, source only | 512 | 0.804 | 0.758 | 0.898 |
| Gemma 2 q4 WebGPU, source only | 256 | 0.797 | 0.756 | 0.898 |
| Gemma 2 q4 WebGPU, source only | 128 | 0.759 | 0.713 | 0.876 |
| Gemma 2 q4 WebGPU, enriched docs | 768 | 0.840 | 0.800 | — |
| Gemma 2 q4 WebGPU, enriched docs | 512 | 0.847 | 0.798 | — |
| Gemma 2 q4 WebGPU, enriched docs | 256 | 0.839 | 0.798 | — |
| Gemma 2 q4 WebGPU, enriched docs | 128 | 0.808 | 0.757 | — |
| Arctic-S q4 WebGPU, source only | 384 | 0.782 | 0.736 | 0.895 |
| Arctic-S q4 WASM, source only | 384 | 0.782 | 0.736 | 0.895 |

BGE enrichment adds **0.0278 MRR** and **0.0317 nDCG** (source `.7918/.7476`, enriched `.8196/.7793` after canonical tag sorting). Gemma's enriched results were generated with fixture tag order before canonical sorting, so treat its enriched scores as approximate comparison only. BGE's selection is a resource, compatibility, schema-fit, and hybrid-quality tradeoff rather than a claim of the highest semantic-only score. Four multilingual queries are too few to establish either model's multilingual quality; BGE is explicitly an English model and this limitation must remain visible.

## Runtime and resource evidence

| Candidate / backend | Initialization | 168+88 embedding batch | Query-only warm samples |
|---|---:|---:|---|
| BGE q4 WebGPU | 5.61 s | 2.36 s; 108.6 vectors/s | 22.6, 14.4, 13.7, 12.2, 15.1 ms |
| BGE q4 WASM | 1.64 s, cached files | 14.80 s; 17.3 vectors/s | 76.9, 78.9, 77.0, 76.2, 80.4 ms |
| Arctic-S q4 WebGPU | 7.99 s | 1.96 s; 130.4 vectors/s | 14.3, 14.3, 16.1, 13.8, 10.9 ms |
| Arctic-S q4 WASM | 1.66 s, cached files | 15.20 s; 16.8 vectors/s | 83.4, 82.9, 84.7, 89.8, 83.3 ms |
| Gemma 2 q4 WebGPU | 2.70 s, cached run | 6.00 s; 42.7 vectors/s | 85.7, 34.7, 33.5, 33.2, 32.4 ms |

The first Gemma query-only sample includes compilation; its remaining four samples have a 33.35 ms median. BGE's measured q4 model payload was **61,317,586 bytes** (132,562-byte graph plus 61,185,024-byte external data). Arctic's q4 graph was **61,440,599 bytes**. Small configuration, tokenizer, and vocabulary assets are additional. Gemma q4 payloads (graph, external weights, and tokenizer) were about 206.7 MB; q8 about 345.9 MB; the full-precision ONNX reference weights were about 1.085 GB before tokenizer/config assets. These are browser download observations, not GPU memory measurements.

For BGE, 256 corresponding document/query vectors from WebGPU and WASM had cosine min/median/mean **0.999352 / 0.999700 / 0.999689**; vector norms were within roughly `0.9999995–1.0000005`. Top-1 agreed for 86/88 queries and mean top-10 overlap was 0.976. Exact full-list rank order differed for all 88 queries because tiny score changes permuted low-ranked near ties. Arctic's corresponding-vector cosine min/median/mean was **0.9999991 / 1.0000000 / 1.0000000** and all 88 full rankings agreed.

Gemma's q4 and q8 WASM attempts both failed with ONNX Runtime's unsupported `GatherBlockQuantized(1)` operator. Gemma q4 WebGPU and full-precision WebGPU both succeeded. On four official model-card examples, q4 and FP32 produced the same four-document ranking; corresponding-vector cosine was 0.988–0.992. q8 and FP32 cosine was 0.99995–0.99997 with the same ranking. This small reference set is a sanity check only, not a trusted quality evaluation. Model config explicitly nulled vision/audio before loading; observed network requests contained only text encoder assets, config, and tokenizer files.

The browser exposed WebGPU features and limits but not adapter identity. No SwiftShader flag was set; the host reports an NVIDIA RTX 3050 Laptop GPU, but Chrome's selected adapter could not be independently identified. **Android is unverified**: no device was visible to ADB. WASM compatibility on this desktop does not establish Android latency or memory suitability.

## Verification and limits

- The isolated development-only feasibility route is under `src/app/embedding-feasibility/`; it calls neither the application API nor the database.
- Synthetic retrieval runs used only the development `bookmark_dev` database and the test runner confirmed cleanup: zero synthetic bookmarks and zero synthetic evaluation tags remained.
- `npm.cmd run typecheck` passed after the feasibility and alternative-model adapters were added.
- No migration, application indexing endpoint, semantic search route, production database change, deployment, or real archive access has been performed as part of this evaluation.
- Vercel Authentication/Deployment Protection remains **UNVERIFIED / BLOCKED** pending owner-side project settings and anonymous-access verification.

## Implementation handoff

Proceed with the BGE 384D contract described above. Keep work divided into non-overlapping packages: (1) embedding contract/preprocessing and unit tests; (2) Drizzle schema plus a new additive migration, lease/retry metadata, and field-aware stale invalidation; (3) browser worker and bounded indexing claim/complete APIs; (4) semantic retrieval and RRF integration while preserving lexical fallback and exact-match priority; (5) indexing/search UI and visible model-unavailable behavior; (6) integration verification and owner setup documentation. Do not run migrations except against the guarded `bookmark_dev` target. Keep Android performance explicitly unverified.
