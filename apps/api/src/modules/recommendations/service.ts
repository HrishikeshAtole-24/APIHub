/**
 * Recommendations and comparison (report FR-05, FR-11, 26).
 *
 * Core principle from report 26.1: "AI should be an augmentation, not the
 * source of truth. AI recommendations should be grounded in structured API
 * metadata and observable signals. The model should not invent endpoints,
 * prices or authentication requirements."
 *
 * So the pipeline here is fully deterministic:
 *
 *   prompt -> intent extraction -> structured filters -> retrieval
 *          -> scoring -> reasons and caveats derived from real fields
 *
 * Every reason shown to a user is generated FROM a catalogue field, so it
 * cannot be a hallucination. An LLM may later add a narrative summary on top,
 * but it never chooses or describes the APIs.
 */
import { topK } from '@apihub/algorithms';
import type {
  ApiSummary,
  CompareResult,
  CompareRow,
  RecommendRequest,
  RecommendResult,
  Recommendation,
} from '@apihub/contracts';
import { AUTH_TYPE_LABELS } from '@apihub/contracts';

import { ApiNotFoundError } from '../../shared/errors.js';
import type { CatalogRepository } from '../catalog/repository.js';
import { parseQuery } from '../search/query-parser.js';
import { rankingStrategyFor } from '../search/ranking.js';
import type { SearchRepository } from '../search/repository.js';

/**
 * Keyword -> category mapping for intent extraction.
 *
 * A curated map rather than an embedding lookup: it is inspectable, instant,
 * and needs no model. The semantic layer improves recall later; this
 * guarantees the common cases are always right.
 */
const CATEGORY_HINTS: Record<string, string[]> = {
  weather: ['weather', 'forecast', 'climate', 'temperature', 'rain'],
  finance: ['payment', 'stripe', 'invoice', 'banking', 'stock', 'currency', 'exchange', 'crypto'],
  geocoding: ['map', 'maps', 'geocode', 'location', 'address', 'places', 'route'],
  news: ['news', 'article', 'headline', 'press', 'journalism'],
  email: ['email', 'smtp', 'mail', 'newsletter', 'transactional'],
  sms: ['sms', 'text message', 'twilio', 'otp'],
  authentication: ['auth', 'login', 'oauth', 'identity', 'sso'],
  images: ['image', 'photo', 'picture', 'thumbnail', 'avatar'],
  video: ['video', 'stream', 'youtube', 'media'],
  music: ['music', 'song', 'audio', 'spotify', 'track'],
  sports: ['sport', 'football', 'cricket', 'nba', 'score', 'match'],
  government: ['government', 'gst', 'tax', 'public record', 'census'],
  health: ['health', 'medical', 'covid', 'fitness', 'nutrition'],
  transport: ['flight', 'train', 'transit', 'airline', 'travel', 'hotel'],
  jobs: ['job', 'career', 'recruit', 'vacancy', 'hiring'],
  ecommerce: ['ecommerce', 'shop', 'product', 'cart', 'order', 'shipping'],
  security: ['security', 'breach', 'vulnerability', 'malware', 'threat'],
  science: ['science', 'space', 'nasa', 'astronomy', 'physics'],
  animals: ['animal', 'dog', 'cat', 'pet', 'wildlife'],
  food: ['food', 'recipe', 'restaurant', 'nutrition', 'meal'],
};

export class RecommendationService {
  constructor(
    private readonly searchRepository: SearchRepository,
    private readonly catalogRepository: CatalogRepository,
  ) {}

  /** Map free text onto catalogue categories. */
  private inferCategories(text: string): string[] {
    const lower = text.toLowerCase();
    const matched: string[] = [];

    for (const [category, keywords] of Object.entries(CATEGORY_HINTS)) {
      if (keywords.some((keyword) => lower.includes(keyword))) matched.push(category);
    }
    return matched;
  }

  async recommend(input: RecommendRequest): Promise<RecommendResult> {
    const startedAt = performance.now();
    const parsed = parseQuery(input.prompt);

    const free = input.constraints.free ?? parsed.inferred.free;
    const noAuth = input.constraints.noAuth ?? parsed.inferred.noAuth;
    const httpsOnly = input.constraints.httpsOnly ?? parsed.inferred.httpsOnly ?? true;

    const inferredCategories =
      input.constraints.categories && input.constraints.categories.length > 0
        ? input.constraints.categories
        // Infer from the CLEANED text: the raw prompt still contains filter
        // phrases, so "no auth" would wrongly match the authentication category.
        : this.inferCategories(parsed.cleanedText);

    const filters = {
      free: free ?? undefined,
      https: httpsOnly ? true : undefined,
      cors: input.constraints.corsRequired ?? undefined,
      auth: noAuth ? 'none' : input.constraints.preferredAuth,
    };

    // Retrieve on the query text; fall back to browsing the inferred category
    // when the prompt has no usable search terms.
    let candidates =
      parsed.tsquery.length > 0
        ? await this.searchRepository.findCandidates(parsed.tsquery, filters, 200)
        : [];

    if (candidates.length === 0 && inferredCategories.length > 0) {
      candidates = await this.searchRepository.findBrowseCandidates(
        { ...filters, category: inferredCategories[0] },
        200,
      );
    }
    if (candidates.length === 0) {
      candidates = await this.searchRepository.findBrowseCandidates(filters, 100);
    }

    const strategy = rankingStrategyFor('lexical');
    const maxTextRank = candidates.reduce((max, c) => Math.max(max, c.textRank), 0);
    const context = { maxTextRank, now: Date.now() };

    const ranked = topK(candidates, input.limit, (candidate) => strategy.score(candidate, context).total);

    const summaries = await this.catalogRepository.findManyByIds(
      ranked.map((entry) => entry.item.id),
    );

    const recommendations: Recommendation[] = summaries.map((api) => ({
      api,
      score: Number((ranked.find((r) => r.item.id === api.id)?.score ?? 0).toFixed(4)),
      reasons: this.buildReasons(api, { free, noAuth, httpsOnly }),
      caveats: this.buildCaveats(api),
    }));

    return {
      recommendations,
      interpretedConstraints: {
        categories: inferredCategories,
        free: free ?? null,
        noAuth: noAuth ?? null,
        httpsOnly: httpsOnly ?? null,
        keywords: parsed.terms,
      },
      // Deterministic narrative; an LLM provider would replace this string
      // without changing which APIs were selected.
      narrative: this.buildNarrative(recommendations, inferredCategories),
      aiGenerated: false,
      tookMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }

  /** Every reason is derived from a real field. Nothing is invented. */
  private buildReasons(
    api: ApiSummary,
    wanted: { free: boolean | null; noAuth: boolean | null; httpsOnly: boolean | null },
  ): string[] {
    const reasons: string[] = [];

    if (api.isFree) reasons.push('Free to use with no credential required');
    else if (api.hasFreeTier) reasons.push('Offers a free tier');

    if (api.authType === 'none') reasons.push('No authentication needed to get started');
    else reasons.push(`Authentication: ${AUTH_TYPE_LABELS[api.authType]}`);

    if (api.httpsSupported) reasons.push('Served over HTTPS');
    if (api.corsStatus === 'yes') reasons.push('CORS enabled, so it works directly from a browser');

    if (api.health.status === 'up') {
      const latency = api.health.latencyMs ? ` (${api.health.latencyMs}ms)` : '';
      reasons.push(`Currently operational${latency}`);
    }
    if (api.health.uptime30d !== null && api.health.uptime30d >= 0.99) {
      reasons.push(`${(api.health.uptime30d * 100).toFixed(1)}% uptime over 30 days`);
    }
    if (api.averageRating !== null && api.reviewCount >= 3) {
      reasons.push(`Rated ${api.averageRating.toFixed(1)}/5 by ${api.reviewCount} developers`);
    }
    if (api.docsUrl) reasons.push('Documentation available');

    void wanted;
    return reasons.slice(0, 5);
  }

  /** Honest downsides. A recommendation that hides them is not useful. */
  private buildCaveats(api: ApiSummary): string[] {
    const caveats: string[] = [];

    if (!api.isFree && !api.hasFreeTier) caveats.push('No documented free tier');
    if (api.authType === 'oauth2' || api.authType === 'oauth') {
      caveats.push('Requires an OAuth flow, which adds integration work');
    }
    if (api.authType === 'apiKey') caveats.push('Requires signing up for an API key');
    if (!api.httpsSupported) caveats.push('Does not support HTTPS');
    if (api.corsStatus === 'no') {
      caveats.push('No CORS support, so browser calls need a server-side proxy');
    }
    if (api.health.status === 'down') caveats.push('Currently failing health checks');
    else if (api.health.status === 'degraded') caveats.push('Currently responding slowly');
    else if (api.health.status === 'unknown') caveats.push('Not yet monitored by APIHub');
    if (!api.docsUrl) caveats.push('No documentation link on record');

    return caveats.slice(0, 4);
  }

  private buildNarrative(recommendations: Recommendation[], categories: string[]): string | null {
    if (recommendations.length === 0) return null;

    const top = recommendations[0];
    if (!top) return null;

    const scope = categories.length > 0 ? ` in ${categories.slice(0, 2).join(' and ')}` : '';
    const freeCount = recommendations.filter((r) => r.api.isFree).length;
    const healthyCount = recommendations.filter((r) => r.api.health.status === 'up').length;

    return (
      `Found ${recommendations.length} option${recommendations.length === 1 ? '' : 's'}${scope}. ` +
      `${top.api.name} ranks highest${top.api.isFree ? ' and is free to use' : ''}. ` +
      `${freeCount} of ${recommendations.length} require no payment, and ` +
      `${healthyCount} are passing health checks right now.`
    );
  }

  /**
   * Side-by-side comparison (report FR-05).
   *
   * The verdict is a weighted sum over the same normalised dimensions the
   * comparison table displays, so the "best for my project" answer is always
   * consistent with the numbers shown above it.
   */
  async compare(slugs: string[]): Promise<CompareResult> {
    const apis = await this.catalogRepository.findManyBySlugs(slugs);
    if (apis.length < 2) throw new ApiNotFoundError(slugs.join(', '));

    const rows: CompareRow[] = [
      this.booleanRow('free', 'Free to use', apis, (api) => api.isFree),
      this.booleanRow('freeTier', 'Free tier', apis, (api) => api.hasFreeTier),
      {
        key: 'auth',
        label: 'Authentication',
        kind: 'text',
        values: apis.map((api) => AUTH_TYPE_LABELS[api.authType]),
        // "No auth" is the easiest to integrate, so it wins this row.
        bestIndex: bestBy(apis, (api) => (api.authType === 'none' ? 1 : 0)),
      },
      this.booleanRow('https', 'HTTPS', apis, (api) => api.httpsSupported),
      this.booleanRow('cors', 'CORS', apis, (api) => api.corsStatus === 'yes'),
      {
        key: 'status',
        label: 'Current status',
        kind: 'text',
        values: apis.map((api) => api.health.status),
        bestIndex: bestBy(apis, (api) => healthRank(api.health.status)),
      },
      {
        key: 'latency',
        label: 'Latency',
        kind: 'latency',
        values: apis.map((api) => api.health.latencyMs),
        bestIndex: bestBy(apis, (api) =>
          api.health.latencyMs === null ? -Infinity : -api.health.latencyMs,
        ),
      },
      {
        key: 'uptime',
        label: 'Uptime (30d)',
        kind: 'score',
        values: apis.map((api) => (api.health.uptime30d === null ? null : api.health.uptime30d * 100)),
        bestIndex: bestBy(apis, (api) => api.health.uptime30d ?? -1),
      },
      {
        key: 'reliability',
        label: 'Reliability score',
        kind: 'score',
        values: apis.map((api) => api.health.reliabilityScore),
        bestIndex: bestBy(apis, (api) => api.health.reliabilityScore ?? -1),
      },
      {
        key: 'rating',
        label: 'Developer rating',
        kind: 'rating',
        values: apis.map((api) => api.averageRating),
        bestIndex: bestBy(apis, (api) => api.averageRating ?? -1),
      },
      {
        key: 'reviews',
        label: 'Reviews',
        kind: 'score',
        values: apis.map((api) => api.reviewCount),
        bestIndex: bestBy(apis, (api) => api.reviewCount),
      },
      this.booleanRow('docs', 'Documentation', apis, (api) => Boolean(api.docsUrl)),
    ];

    const scores = apis.map((api) => this.comparisonScore(api));
    const winnerIndex = scores.indexOf(Math.max(...scores));
    const winner = apis[winnerIndex];

    return {
      apis,
      rows,
      verdict: {
        winnerIndex: winner ? winnerIndex : null,
        reasons: winner ? this.buildReasons(winner, { free: null, noAuth: null, httpsOnly: null }) : [],
        scores: scores.map((score) => Number(score.toFixed(3))),
      },
    };
  }

  private booleanRow(
    key: string,
    label: string,
    apis: ApiSummary[],
    predicate: (api: ApiSummary) => boolean,
  ): CompareRow {
    const values = apis.map(predicate);
    return {
      key,
      label,
      kind: 'boolean',
      values,
      bestIndex: values.some(Boolean) ? values.indexOf(true) : null,
    };
  }

  /** Weighted overall score used only for the comparison verdict. */
  private comparisonScore(api: ApiSummary): number {
    let score = 0;
    score += api.isFree ? 0.2 : api.hasFreeTier ? 0.12 : 0;
    score += api.authType === 'none' ? 0.15 : api.authType === 'apiKey' ? 0.08 : 0.03;
    score += api.httpsSupported ? 0.1 : 0;
    score += api.corsStatus === 'yes' ? 0.08 : 0;
    score += ((api.health.reliabilityScore ?? 50) / 100) * 0.2;
    score += (api.health.uptime30d ?? 0.5) * 0.12;
    score += ((api.averageRating ?? 3) / 5) * 0.1;
    score += api.docsUrl ? 0.05 : 0;
    return score;
  }
}

function healthRank(status: string): number {
  switch (status) {
    case 'up':
      return 3;
    case 'degraded':
      return 2;
    case 'unknown':
      return 1;
    default:
      return 0;
  }
}

/** Index of the highest-scoring entry, or null when nothing scores. */
function bestBy<T>(items: T[], score: (item: T) => number): number | null {
  let bestIndex: number | null = null;
  let bestScore = -Infinity;

  items.forEach((item, index) => {
    const value = score(item);
    if (value > bestScore) {
      bestScore = value;
      bestIndex = index;
    }
  });

  return bestScore === -Infinity ? null : bestIndex;
}
