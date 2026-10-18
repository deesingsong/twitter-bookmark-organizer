/** Synthetic data only. An adapter maps these records into the system under test. */
export interface SyntheticSearchBookmark {
  id: string;
  tweetId: string;
  canonicalUrl: string;
  text: string | null;
  authorUsername: string | null;
  note: string;
  tags: readonly string[];
  collections: readonly string[];
  tweetCreatedAt: string | null;
  hasMedia: boolean;
  language: string | null;
}

/** Adapter-level filters; map these to the evaluator target's own input contract. */
export interface EvaluationFilters {
  author?: string;
  tag?: string;
  collection?: string;
  /** Inclusive UTC instant; excludes records with an unknown tweet date. */
  from?: string;
  /** Inclusive UTC instant; excludes records with an unknown tweet date. */
  to?: string;
}

export interface EvaluationRequest {
  query: string;
  filters?: EvaluationFilters;
  limit: number;
  cursor?: string;
}

export interface EvaluationPage {
  hits: readonly { id: string }[];
  nextCursor: string | null;
}

/** No HTTP, database driver, or production query implementation is required. */
export type SearchEvaluator = (request: EvaluationRequest) => Promise<EvaluationPage>;

export interface SearchEvaluationCase {
  id: string;
  query: string;
  filters?: EvaluationFilters;
  /** Hand-labeled relevance judgments for Recall@10 and MRR@10. */
  relevantIds: readonly string[];
  requiredIds?: readonly string[];
  firstId?: string;
  before?: readonly (readonly [string, string])[];
  excludedIds?: readonly string[];
  empty?: boolean;
  /** Evaluate complete traversal on a fixed, unchanged synthetic snapshot. */
  pagination?: { limit: number; expectedIds: readonly string[] };
}
