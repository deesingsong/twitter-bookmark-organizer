/** Standalone invented records; adapters decide how to index their text/metadata. */
export interface SemanticEvaluationDocument {
  readonly id: string;
  readonly tweetId: string;
  readonly canonicalUrl: string;
  readonly authorUsername: string;
  /** Primary source text stays separate for preprocessing comparisons. */
  readonly text: string;
  readonly quotedText?: string;
  /** Synthetic owner annotations, never imported source text. */
  readonly note?: string;
  readonly tags?: readonly string[];
  readonly language: string;
}

export type SemanticQueryKind = "conceptual" | "paraphrase" | "lexical" | "exact";
export type SemanticQueryContext = "quoted-text" | "owner-note" | "owner-tags" | "multilingual";

/** 3 = directly answers the intent, 2 = useful supporting answer, 1 = partial. */
export type RelevanceGrade = 1 | 2 | 3;
export type RelevanceJudgments = Readonly<Record<string, RelevanceGrade>>;

export interface SemanticEvaluationQuery {
  readonly id: string;
  readonly kind: SemanticQueryKind;
  readonly query: string;
  /** Optional evaluation slices; neither field belongs in embedding input. */
  readonly context?: SemanticQueryContext;
  readonly language?: string;
  /** Explicit authored judgments; absent IDs receive zero gain for this fixture. */
  readonly relevance: RelevanceJudgments;
  /** Explain the intent and important nearby exclusions for later review. */
  readonly rationale: string;
}

export interface ScoredSemanticCandidate {
  readonly id: string;
  /** Larger means better. Convert distances before using the ranking helper. */
  readonly score: number;
}

export interface MetricsAt10 {
  /** Null means the query has no positive judgments, so it is not scored. */
  readonly recallAt5: number | null;
  readonly recallAt10: number | null;
  /** Fixed denominator of ten, including when fewer than ten results are returned. */
  readonly precisionAt10: number | null;
  readonly reciprocalRankAt10: number | null;
  readonly ndcgAt10: number | null;
}

export interface SemanticQueryResult extends MetricsAt10 {
  readonly id: string;
  readonly kind: SemanticQueryKind;
  readonly rankedIds: readonly string[];
}

export interface SemanticMetricSummary {
  readonly queryCount: number;
  readonly judgedQueryCount: number;
  readonly meanRecallAt5: number | null;
  readonly meanRecallAt10: number | null;
  readonly meanPrecisionAt10: number | null;
  readonly meanReciprocalRankAt10: number | null;
  readonly meanNdcgAt10: number | null;
}

export interface SemanticEvaluationReport extends SemanticMetricSummary {
  readonly results: readonly SemanticQueryResult[];
  readonly byKind: Readonly<Partial<Record<SemanticQueryKind, SemanticMetricSummary>>>;
}

/** Supply the result order from lexical, semantic, or hybrid retrieval unchanged. */
export type SemanticEvaluationRanker = (
  query: SemanticEvaluationQuery,
) => readonly string[] | Promise<readonly string[]>;
