/**
 * Search ranking (Strategy pattern, report 15.1 / 15.2 / 21.2).
 *
 * The report specifies the scoring model exactly:
 *
 *   score = 0.45*text_relevance
 *         + 0.15*popularity
 *         + 0.15*reliability
 *         + 0.10*freshness
 *         + 0.10*free_tier_score
 *         + 0.05*documentation_score
 *
 * Two things make this implementation worth the file:
 *
 *  1. Retrieval and ranking are separated (report 21.2). PostgreSQL retrieves a
 *     bounded candidate set using the GIN index; scoring then runs in
 *     application code over those candidates only, never the whole catalogue.
 *
 *  2. Every component is normalised to 0..1 before weighting. Mixing a
 *     ts_rank (unbounded, typically 0.0-1.0), a latency in milliseconds and a
 *     star rating without normalising would let whichever has the largest
 *     numeric range silently dominate.
 *
 * The breakdown is returned with each hit so the UI can explain the ordering.
 */
import { HYBRID_RANK_WEIGHTS, LATENCY_SCORE_CEILING_MS, LEXICAL_RANK_WEIGHTS } from '@apihub/config';
import type { ScoreBreakdown } from '@apihub/contracts';

/** Everything the ranker needs about one candidate. */
export interface RankingCandidate {
  id: string;
  /** Raw ts_rank from PostgreSQL. */
  textRank: number;
  popularityScore: number;
  reliabilityScore: number | null;
  latencyMs: number | null;
  updatedAt: Date;
  isFree: boolean;
  hasFreeTier: boolean;
  hasDocs: boolean;
  hasEndpoints: boolean;
  httpsSupported: boolean;
  /** Cosine similarity in 0..1 when semantic retrieval contributed. */
  semanticScore?: number | null;
}

export interface RankingStrategy {
  readonly name: string;
  score(candidate: RankingCandidate, context: RankingContext): ScoreBreakdown;
}

export interface RankingContext {
  /** Highest ts_rank in the candidate set, used to normalise text relevance. */
  maxTextRank: number;
  now: number;
}

/** Clamp to the unit interval; guards against NaN and out-of-range inputs. */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalise ts_rank against the best score in this result set.
 *
 * ts_rank has no fixed upper bound and its magnitude depends on document
 * length and term frequency, so an absolute scale is meaningless. Relative
 * normalisation makes the top hit 1.0 for any query.
 */
export function normalizeTextRank(rank: number, maxRank: number): number {
  if (maxRank <= 0) return 0;
  return unit(rank / maxRank);
}

/**
 * Freshness decays over roughly a year.
 *
 * A record updated today scores 1; one untouched for 12 months scores ~0. This
 * gently favours maintained entries without burying stable, correct ones.
 */
export function freshnessScore(updatedAt: Date, now: number): number {
  const ageDays = (now - updatedAt.getTime()) / 86_400_000;
  if (ageDays <= 0) return 1;
  return unit(Math.exp(-ageDays / 180));
}

/** Latency mapped to 0..1: instant is 1, at/above the ceiling is 0. */
export function latencyScore(latencyMs: number | null): number {
  if (latencyMs === null) return 0.5; // unknown is neutral, not penalised
  return unit(1 - latencyMs / LATENCY_SCORE_CEILING_MS);
}

/** Reliability, blending the composite score with observed latency. */
export function reliabilityScore(candidate: RankingCandidate): number {
  if (candidate.reliabilityScore === null) {
    // Never probed: neutral rather than zero, so new entries are not buried.
    return 0.5;
  }
  return unit(candidate.reliabilityScore / 100) * 0.8 + latencyScore(candidate.latencyMs) * 0.2;
}

/** Free-tier desirability: no credential at all beats a free tier behind a key. */
export function freeTierScore(candidate: RankingCandidate): number {
  if (candidate.isFree) return 1;
  if (candidate.hasFreeTier) return 0.6;
  return 0.1;
}

/** Proxy for documentation quality from the signals we actually hold. */
export function documentationScore(candidate: RankingCandidate): number {
  let score = 0;
  if (candidate.hasDocs) score += 0.6;
  if (candidate.hasEndpoints) score += 0.3;
  if (candidate.httpsSupported) score += 0.1;
  return unit(score);
}

/** Lexical ranking: the V1 model from report 15.1. */
export class LexicalRankingStrategy implements RankingStrategy {
  readonly name = 'lexical';

  score(candidate: RankingCandidate, context: RankingContext): ScoreBreakdown {
    const weights = LEXICAL_RANK_WEIGHTS;

    const textRelevance = normalizeTextRank(candidate.textRank, context.maxTextRank);
    const popularity = unit(candidate.popularityScore / 100);
    const reliability = reliabilityScore(candidate);
    const freshness = freshnessScore(candidate.updatedAt, context.now);
    const freeTier = freeTierScore(candidate);
    const documentation = documentationScore(candidate);

    const total =
      weights.textRelevance * textRelevance +
      weights.popularity * popularity +
      weights.reliability * reliability +
      weights.freshness * freshness +
      weights.freeTier * freeTier +
      weights.documentation * documentation;

    return {
      total,
      textRelevance,
      popularity,
      reliability,
      freshness,
      freeTier,
      documentation,
      semantic: null,
    };
  }
}

/**
 * Hybrid ranking: the V2 model from report 15.2.
 *
 *   final = 0.55*lexical + 0.25*semantic + 0.10*reliability + 0.10*popularity
 *
 * Semantic similarity augments lexical matching, it does not replace it — the
 * report is explicit that exact keyword search must survive.
 */
export class HybridRankingStrategy implements RankingStrategy {
  readonly name = 'hybrid';
  private readonly lexical = new LexicalRankingStrategy();

  score(candidate: RankingCandidate, context: RankingContext): ScoreBreakdown {
    const lexicalBreakdown = this.lexical.score(candidate, context);
    const semantic = unit(candidate.semanticScore ?? 0);
    const weights = HYBRID_RANK_WEIGHTS;

    const total =
      weights.lexical * lexicalBreakdown.total +
      weights.semantic * semantic +
      weights.reliability * lexicalBreakdown.reliability +
      weights.popularity * lexicalBreakdown.popularity;

    return { ...lexicalBreakdown, semantic, total };
  }
}

/** Ranking used when there is no query text: popularity and reliability only. */
export class BrowseRankingStrategy implements RankingStrategy {
  readonly name = 'browse';

  score(candidate: RankingCandidate, context: RankingContext): ScoreBreakdown {
    const popularity = unit(candidate.popularityScore / 100);
    const reliability = reliabilityScore(candidate);
    const freshness = freshnessScore(candidate.updatedAt, context.now);
    const freeTier = freeTierScore(candidate);
    const documentation = documentationScore(candidate);

    return {
      total: popularity * 0.5 + reliability * 0.25 + freeTier * 0.15 + documentation * 0.1,
      textRelevance: 0,
      popularity,
      reliability,
      freshness,
      freeTier,
      documentation,
      semantic: null,
    };
  }
}

export function rankingStrategyFor(mode: 'lexical' | 'hybrid' | 'browse'): RankingStrategy {
  switch (mode) {
    case 'hybrid':
      return new HybridRankingStrategy();
    case 'browse':
      return new BrowseRankingStrategy();
    default:
      return new LexicalRankingStrategy();
  }
}
