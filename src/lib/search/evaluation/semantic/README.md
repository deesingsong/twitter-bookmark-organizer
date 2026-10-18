# Synthetic semantic retrieval evaluation

This standalone fixture contains **168 invented bookmark-like posts and 88 queries**. The main 20 English topics each have eight distinct posts, including nearby alternatives and word-sense distractors. Eight supplemental documents exercise quoted text, owner annotations, and Spanish, French, German, and Malay text. Query counts are 24 conceptual, 22 paraphrase, 22 lexical, and 20 exact. IDs, handles, URLs, and prose are synthetic. Nothing is downloaded or read from an archive.

`fixtures.ts` records explicit author-assigned relevance grades and a rationale for every query. The judgments were reviewed against the invented text; they are not independent human annotations or labels produced by a retrieval model. Grade 3 directly answers the intent, grade 2 provides a useful supporting answer, and grade 1 provides a partial answer or an immediately useful caution. An absent ID receives zero gain in this closed fixture. Query kind and rationale are evaluation metadata: do not include them, judgments, or document IDs in embedding text.

Primary `text`, optional `quotedText`, and owner-created `note`/`tags` remain separate document fields. Four labeled queries require evidence found only in a quote, note, or tag. Compare primary-text-only and enriched preprocessing without modifying the stored primary text. Four more queries carry `context: "multilingual"` and explicit language codes matching their relevant documents. These are diagnostic cases; their presence does not establish multilingual model support. Query `context`, `language`, `kind`, `rationale`, and relevance grades are evaluation metadata and must not be appended to embedding input.

Use `SYNTHETIC_SEMANTIC_DOCUMENTS` to populate an isolated evaluation target, mapping selected content fields through the same production preprocessing contract. Pass `runSemanticEvaluation` a callback that receives a query and returns ranked document IDs. Run lexical, semantic, and hybrid adapters separately against the same documents and judgments. The runner preserves adapter order and reports macro averages overall and by query kind. Use its `queries` option with filtered query lists to report context or language slices separately. It makes no network, model, database, or application calls itself.

`rankDeterministically` is available when an adapter produces similarity scores: larger scores rank first, with ascending ID by UTF-16 code units breaking ties. It rejects nonfinite scores and duplicate candidate IDs without mutating the input. Convert distance values to a larger-is-better score before calling it. Do not re-sort an adapter's completed ranking using unrelated scores.

`vectors.ts` evaluates browser-generated vectors from an in-memory or local synthetic benchmark artifact. It validates matrix sizes, truncates before L2 normalization, computes cosine similarity, and feeds ranked IDs through the same metric implementation. It does not read files, access the database, or contact a model host. Browser inference runners should save outputs only under ignored local benchmark artifacts and must not save real bookmark text or vectors.

Metrics use fixed rank cutoffs:

- **Recall@5:** distinct positively judged hits in the first five slots divided by all positive judgments for that query.
- **Recall@10:** distinct positively judged hits divided by all positive judgments for that query.
- **Precision@10:** distinct positively judged hits in the first ten slots divided by **ten**, even if the adapter returns fewer results. Missing result slots earn no credit.
- **MRR@10:** the reciprocal rank of the first positively judged hit, or zero if none occurs.
- **nDCG@10:** discounted gain divided by the ideal top-ten gain, using gain `2^grade - 1` and discount `log2(rank + 1)` with ranks starting at one.

Duplicate hits consume their original slots and earn no repeated gain. Rank six never contributes to Recall@5; rank eleven never contributes to the other metrics. Queries without positive judgments return null metrics and are excluded from averages. Ranker failures abort the report with a generic error. There is no quality threshold or automatic claim that one retrieval method is better.

Run the focused checks from the project root:

```powershell
npx vitest run src/lib/search/evaluation/semantic/semantic.test.ts
npx eslint src/lib/search/evaluation/semantic
npm run typecheck
```

Tests verify fixture references, literal lookups, context separation, multilingual labels, metric arithmetic, rank cutoffs, duplicate handling, and deterministic ties. The artificial ideal-ranking test checks the harness only; it is not a measured retrieval result. Actual model quality, full-text behavior, multilingual quality, latency, and production privacy remain outside this fixture's evidence. A larger independently judged set is needed before generalizing results beyond these authored examples.
