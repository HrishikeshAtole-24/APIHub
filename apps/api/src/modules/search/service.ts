/**
 * Search service (report 15, 21.2).
 *
 * Pipeline:
 *
 *   query text
 *     -> parse (safe tsquery + inferred filters)
 *     -> retrieve bounded candidates   (PostgreSQL GIN index)
 *     -> broaden if too few            (AND -> OR -> fuzzy)
 *     -> score every candidate         (RankingStrategy)
 *     -> Top-K with a size-K min-heap  (O(N log K), report 21.1)
 *     -> hydrate only the K survivors  (one batched query)
 *
 * Hydration order matters for performance: full API summaries with categories
 * and aggregates are fetched only for the page being returned, never for all
 * 400 candidates.
 */
import { topK } from '@apihub/algorithms';
import { similarityRatio } from '@apihub/algorithms';
import { CACHE_KEYS, CACHE_TTL } from '@apihub/config';
import type {
  ApiSummary,
  SearchHit,
  SearchQuery,
  SearchResult,
  Suggestion,
} from '@apihub/contracts';
import { buildPaginationMeta, type PaginationMeta } from '@apihub/contracts';
import type { CacheService } from '@apihub/runtime';

import type { CatalogRepository } from '../catalog/repository.js';
import { hashQuery } from '../catalog/service.js';
import { highlight, parseQuery, toOrQuery } from './query-parser.js';
import { rankingStrategyFor, type RankingCandidate } from './ranking.js';
import { CANDIDATE_LIMIT, type SearchRepository } from './repository.js';

/** Below this many results, broaden the query before giving up. */
const BROADEN_THRESHOLD = 5;

export class SearchService {
  constructor(
    private readonly searchRepository: SearchRepository,
    private readonly catalogRepository: CatalogRepository,
    private readonly cache: CacheService,
  ) {}

  async search(
    query: SearchQuery,
  ): Promise<{ result: SearchResult; pagination: PaginationMeta; cached: boolean }> {
    const key = CACHE_KEYS.search(hashQuery(query as unknown as Record<string, unknown>));
    let cached = true;

    const payload = await this.cache.getOrSet(
      key,
      async () => {
        cached = false;
        return this.execute(query);
      },
      { ttlSeconds: CACHE_TTL.search },
    );

    return {
      result: payload.result,
      pagination: buildPaginationMeta(query.page, query.pageSize, payload.total),
      cached,
    };
  }

  private async execute(
    query: SearchQuery,
  ): Promise<{ result: SearchResult; total: number }> {
    const startedAt = performance.now();
    const parsed = parseQuery(query.q);

    // Filters set explicitly in the UI take precedence over ones inferred
    // from the query text: an explicit choice must never be overridden.
    const filters = {
      free: query.free ?? parsed.inferred.free ?? undefined,
      https: query.https ?? parsed.inferred.httpsOnly ?? undefined,
      cors: query.cors ?? parsed.inferred.corsRequired ?? undefined,
      auth: query.auth ?? (parsed.inferred.noAuth ? 'none' : undefined),
      category: query.category,
      status: query.status,
      tags: query.tags,
    };

    let candidates: (RankingCandidate & { name: string; description: string })[] = [];
    let usedFallback = false;

    if (parsed.tsquery.length > 0) {
      candidates = await this.searchRepository.findCandidates(parsed.tsquery, filters);

      // Broaden: AND was too strict, try OR across the same terms.
      if (candidates.length < BROADEN_THRESHOLD && parsed.terms.length > 1) {
        const orQuery = toOrQuery(parsed);
        if (orQuery) {
          candidates = await this.searchRepository.findCandidates(orQuery, filters);
        }
      }

      // Still nothing: fall back to fuzzy name matching for typos.
      if (candidates.length === 0) {
        candidates = await this.searchRepository.findFuzzyCandidates(parsed.terms, filters);
        usedFallback = candidates.length > 0;
      }
    } else {
      candidates = await this.searchRepository.findBrowseCandidates(filters);
    }

    const total = candidates.length;

    // Analytics is best-effort and must not affect the response.
    void this.searchRepository.recordSearch(query.q, total).catch(() => {});

    // Rank the bounded candidate set.
    const mode = parsed.tsquery.length === 0 ? 'browse' : query.mode;
    const strategy = rankingStrategyFor(mode);
    const maxTextRank = candidates.reduce((max, c) => Math.max(max, c.textRank), 0);
    const context = { maxTextRank, now: Date.now() };

    const breakdowns = new Map<string, ReturnType<typeof strategy.score>>();
    for (const candidate of candidates) {
      breakdowns.set(candidate.id, strategy.score(candidate, context));
    }

    // Top-K over the page window. Selecting page*pageSize keeps deep paging
    // correct while still using the bounded-heap selection.
    const window = Math.min(query.page * query.pageSize, CANDIDATE_LIMIT);
    const ranked = topK(candidates, window, (candidate) => breakdowns.get(candidate.id)?.total ?? 0);

    const pageSlice = ranked.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);

    // Hydrate ONLY the page, not the whole candidate set.
    const summaries = await this.catalogRepository.findManyByIds(
      pageSlice.map((entry) => entry.item.id),
    );
    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));

    const hits: SearchHit[] = pageSlice
      .map((entry) => {
        const api = summaryById.get(entry.item.id);
        if (!api) return null;

        const hit: SearchHit = {
          api,
          score: Number(entry.score.toFixed(4)),
          breakdown: breakdowns.get(entry.item.id),
          matchedTerms: parsed.terms,
        };

        const nameHighlight = highlight(entry.item.name, parsed.terms, 120);
        const descriptionHighlight = highlight(entry.item.description, parsed.terms);
        if (nameHighlight || descriptionHighlight) {
          hit.highlights = { name: nameHighlight, description: descriptionHighlight };
        }
        return hit;
      })
      .filter((hit): hit is SearchHit => hit !== null);

    const didYouMean =
      total < BROADEN_THRESHOLD ? await this.suggestCorrection(query.q, parsed.terms) : null;

    return {
      result: {
        hits,
        didYouMean,
        tookMs: Math.round((performance.now() - startedAt) * 100) / 100,
        mode: usedFallback ? 'lexical' : mode === 'browse' ? 'lexical' : mode,
      },
      total,
    };
  }

  /**
   * "Did you mean?" via edit distance against popular API names.
   *
   * Scoped to the top 500 names so the comparison stays bounded, and only
   * offered above a similarity floor to avoid nonsense suggestions.
   */
  private async suggestCorrection(original: string, terms: string[]): Promise<string | null> {
    if (terms.length === 0 || original.length < 3) return null;

    const names = await this.cache.getOrSet(
      'search:spellcheck:names',
      () => this.searchRepository.namesForSpellCheck(),
      { ttlSeconds: 900 },
    );

    const target = original.trim().toLowerCase();
    let best: { name: string; score: number } | null = null;

    for (const name of names) {
      const score = similarityRatio(target, name.toLowerCase());
      if (!best || score > best.score) best = { name, score };
    }

    // 0.6 is high enough to exclude unrelated names while still catching
    // realistic typos such as "opnweather" -> "OpenWeather".
    return best && best.score >= 0.6 && best.name.toLowerCase() !== target ? best.name : null;
  }

  async suggest(prefix: string, limit: number): Promise<Suggestion[]> {
    const normalised = prefix.trim().toLowerCase();
    if (normalised.length === 0) return [];

    return this.cache.getOrSet(
      CACHE_KEYS.suggest(`${normalised}:${limit}`),
      async () => {
        const rows = await this.searchRepository.suggest(normalised, limit);
        return rows.map(
          (row): Suggestion => ({
            text: row.text,
            type: row.type,
            slug: row.slug,
            hint: row.hint,
          }),
        );
      },
      { ttlSeconds: CACHE_TTL.suggest },
    );
  }

  /** Related APIs by shared category, used by the detail page. */
  async related(apiId: string, limit = 6): Promise<ApiSummary[]> {
    const alternatives = await this.catalogRepository.findAlternatives(apiId, limit);
    return this.catalogRepository.findManyByIds(alternatives.map((entry) => entry.id));
  }
}
