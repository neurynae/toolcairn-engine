import type { PackageChannel, ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { ClarificationEngine } from './clarification/engine.js';
import type { SearchSessionManager } from './session.js';
import { buildExactLookupMaps, stage0ExactResolve } from './stages/stage0-exact.js';
import { stage1HybridSearch } from './stages/stage1-hybrid.js';
import { stage2ApplyFilters } from './stages/stage2-filters.js';
import { stage3GraphRerank } from './stages/stage3-graph.js';
import { stage4Select } from './stages/stage4-select.js';
import {
  buildTopicVocabulary,
  computeTopicMatchIds,
  extractTopicsFromQuery,
} from './topic-filter.js';
import type {
  SearchContext,
  SearchPipelineInput,
  SearchPipelineResult,
  ToolScoredResult,
} from './types.js';

const logger = createLogger({ name: '@toolcairn/search:pipeline' });

// ─── BM25 index cache ────────────────────────────────────────────────────────
// Built once on first request, cached for process lifetime (~50MB for 30K tools).
// Eliminates per-request corpus loading (~3s) and BM25 index building (~100ms).
// Invalidated by server restart (every deploy restarts the container).

// Dynamic import to avoid Biome stripping static import as "unused"
async function loadBm25Deps() {
  const { buildBm25Index: build } = await import('@toolcairn/vector');
  return { build };
}

let _cachedBm25Index: import('@toolcairn/vector').Bm25IndexData | null = null;
let _bm25CachePromise: Promise<import('@toolcairn/vector').Bm25IndexData> | null = null;

/**
 * Get or build the cached BM25 index. Thread-safe: concurrent callers share
 * the same build promise. The corpus is freed after index creation.
 */
async function getCachedBm25Index(
  pipeline: SearchPipeline,
): Promise<import('@toolcairn/vector').Bm25IndexData> {
  if (_cachedBm25Index) return _cachedBm25Index;
  if (_bm25CachePromise) return _bm25CachePromise;

  _bm25CachePromise = (async () => {
    const corpus = await pipeline.loadToolCorpus();
    const { build } = await loadBm25Deps();
    const index = build(corpus);
    logger.info({ toolCount: corpus.length }, 'BM25 index cached');
    _cachedBm25Index = index;
    _bm25CachePromise = null;
    // corpus goes out of scope → GC frees ~100MB, only index (~50MB) remains
    return index;
  })();

  return _bm25CachePromise;
}

// ─── Topic vocabulary cache ──────────────────────────────────────────────────
// Built once alongside the BM25 index, cached for process lifetime.
// ~1,764 unique topics with 10+ tools. O(1) lookup per query token.
let _cachedTopicVocab: Set<string> | null = null;
let _cachedTopicCorpus: ToolNode[] | null = null;

/** Minimum topic-matching tool IDs to use topic-filtered search (Level 1). */
const TOPIC_FILTER_MIN_POOL = 10;
/** Minimum results from topic-filtered search before falling back. */
const TOPIC_FILTER_MIN_RESULTS = 3;
/** Score multiplier for topic-overlapping tools in Level 3 (unfiltered + bonus). */
const TOPIC_BONUS_MULTIPLIER = 1.5;

export interface RunStages2to4Result {
  results: ToolScoredResult[];
  is_two_option: boolean;
  stage2_ms: number;
  stage3_ms: number;
  stage4_ms: number;
}

export class SearchPipeline {
  private readonly clarificationEngine = new ClarificationEngine();

  constructor(private readonly sessionManager: SearchSessionManager) {}

  async run(input: SearchPipelineInput): Promise<SearchPipelineResult> {
    const t0 = Date.now();
    const { query, sessionId, context } = input;

    await this.sessionManager.touchSession(sessionId);

    // Load tool corpus from Qdrant (full payloads stored at index time)
    const allTools = await this.loadToolCorpus();

    logger.debug({ sessionId, query, toolCount: allTools.length }, 'Pipeline run started');

    // Stage 0 — exact-match short-circuit for direct name/package queries
    const lookupMaps = buildExactLookupMaps(allTools);
    const stage0 = stage0ExactResolve(query, lookupMaps);
    if (stage0.match) {
      const total_ms = Date.now() - t0;
      logger.info(
        { sessionId, tool: stage0.match.name, total_ms },
        'Stage 0 exact match — short-circuit',
      );
      const result: SearchPipelineResult = {
        sessionId,
        query,
        results: [{ tool: stage0.match, score: 1.0 }],
        is_two_option: false,
        stage1_ms: 0,
        stage2_ms: 0,
        stage3_ms: 0,
        stage4_ms: 0,
        total_ms,
      };
      await this.sessionManager.saveResults(sessionId, result);
      return result;
    }

    // Stage 1 — hybrid retrieval (pass lookupMaps for graph entity expansion)
    const stage1 = await stage1HybridSearch(query, allTools, lookupMaps);
    logger.debug({ elapsed_ms: stage1.elapsed_ms, count: stage1.ids.length }, 'Stage 1 complete');

    // Stage 2 — payload filters
    const stage2 = await stage2ApplyFilters(stage1.ids, context);
    logger.debug({ elapsed_ms: stage2.elapsed_ms, count: stage2.hits.length }, 'Stage 2 complete');

    // Stage 3 — graph re-ranking (pass intent for weight adjustments)
    const stage3 = await stage3GraphRerank(stage2, stage1.intent);
    logger.debug(
      { elapsed_ms: stage3.elapsed_ms, count: stage3.results.length },
      'Stage 3 complete',
    );

    // Stage 4 — precision selection (with optional user preference boost)
    const userPrefs = input.userId ? await loadUserPreferences(input.userId) : undefined;
    const stage4 = stage4Select(stage3, userPrefs);
    logger.debug(
      { elapsed_ms: stage4.elapsed_ms, is_two_option: stage4.is_two_option },
      'Stage 4 complete',
    );

    const total_ms = Date.now() - t0;
    logger.info({ sessionId, total_ms, is_two_option: stage4.is_two_option }, 'Pipeline complete');

    const result: SearchPipelineResult = {
      sessionId,
      query,
      results: stage4.results,
      is_two_option: stage4.is_two_option,
      stage1_ms: stage1.elapsed_ms,
      stage2_ms: stage2.elapsed_ms,
      stage3_ms: stage3.elapsed_ms,
      stage4_ms: stage4.elapsed_ms,
      total_ms,
    };

    await this.sessionManager.saveResults(sessionId, result);
    return result;
  }

  /**
   * Run stages 2–4 against a pre-computed set of candidate IDs (from Stage 1).
   * Used by search_tools_respond so it doesn't re-run Stage 1 after clarification.
   */
  async runStages2to4(
    candidateIds: string[],
    context: SearchContext | undefined,
    sessionId: string,
  ): Promise<RunStages2to4Result> {
    const stage2 = await stage2ApplyFilters(candidateIds, context);
    const stage3 = await stage3GraphRerank(stage2);
    const stage4 = stage4Select(stage3);
    await this.sessionManager.saveResults(sessionId, stage4.results);
    return {
      results: stage4.results,
      is_two_option: stage4.is_two_option,
      stage2_ms: stage2.elapsed_ms,
      stage3_ms: stage3.elapsed_ms,
      stage4_ms: stage4.elapsed_ms,
    };
  }

  /**
   * Run stages 1–3 for stack recommendations.
   * Differs from the standard pipeline: skips clarification, skips stage 4 (precision
   * selection returns only 1-2 winners), and returns the top `limit` ranked tools
   * from stage 3 so the caller can present a multi-tool stack.
   * No DB session persistence — fire-and-forget.
   */
  async runStages1to3ForStack(
    query: string,
    context: SearchContext | undefined,
    limit: number,
  ): Promise<ToolScoredResult[]> {
    const allTools = await this.loadToolCorpus();
    const stage1 = await stage1HybridSearch(query, allTools);
    const stage2 = await stage2ApplyFilters(stage1.ids, context);
    const stage3 = await stage3GraphRerank(stage2);
    return stage3.results.slice(0, limit);
  }

  /**
   * Stack-optimized search: BM25 and vector contribute equally (1:1).
   *
   * Uses a CACHED BM25 index (built once, ~50MB) instead of loading the full
   * 30K+ tool corpus per request. No per-request corpus loading, no per-request
   * BM25 index building. Scales to 100K+ tools and concurrent users.
   *
   * Balanced weights let BM25 find tools for EACH query token independently
   * (e.g. "continuous integration" → Jenkins, "argument parser" → commander.js)
   * while vector provides semantic quality filtering.
   */
  async runStages1to3ForStackBalanced(
    query: string,
    context: SearchContext | undefined,
    limit: number,
  ): Promise<ToolScoredResult[]> {
    const bm25Index = await getCachedBm25Index(this);
    const stage1 = await stage1HybridSearch(
      query,
      [], // allTools not needed — BM25 uses cached index
      undefined,
      { bm25Weight: 1.0, vectorWeight: 1.0 },
      bm25Index,
    );
    const stage2 = await stage2ApplyFilters(stage1.ids, context);
    const stage3 = await stage3GraphRerank(stage2);
    return stage3.results.slice(0, limit);
  }

  /**
   * Per-sub-need search with 3-level topic filtering for domain relevance.
   *
   * Problem: searching ALL 13K+ tools for every sub-need query lets high-star
   * irrelevant tools (qdrant, pandas, freeCodeCamp) dominate via Stage 2's
   * 80% credibility weight. Topic filtering narrows the candidate pool to
   * domain-relevant tools BEFORE credibility scoring.
   *
   * Level 1: Topic-filtered search — extract topics from query, filter both
   *   BM25 and Qdrant vector results to tools with matching topics.
   * Level 2: Unfiltered search with topic bonus — run standard search but
   *   boost score of tools with topic overlap by 1.5x.
   * Level 3: Pure unfiltered fallback — no topic signals or too few matches.
   *
   * Skips Stage 3 graph rerank (graph popularity is noise for precise sub-needs).
   * Uses cached BM25 index — zero per-request corpus loading.
   */
  async runStages1to2ForSubNeed(
    query: string,
    context: SearchContext | undefined,
    limit: number,
  ): Promise<ToolScoredResult[]> {
    const bm25Index = await getCachedBm25Index(this);
    const vocabulary = await this.getTopicVocabulary();
    const topics = extractTopicsFromQuery(query, vocabulary);

    // Precompute topic-matching tool IDs from cached corpus
    const corpus = await this.getCachedCorpus();
    const topicMatchIds =
      topics.length > 0 ? computeTopicMatchIds(corpus, topics) : new Set<string>();

    // ── Level 1: Topic-filtered search ─────────────────────────────────────
    if (topics.length > 0 && topicMatchIds.size >= TOPIC_FILTER_MIN_POOL) {
      logger.debug(
        { query, topics, matchCount: topicMatchIds.size },
        'Sub-need Level 1: topic-filtered search',
      );
      const stage1 = await stage1HybridSearch(
        query,
        [],
        undefined,
        { bm25Weight: 1.0, vectorWeight: 1.0 },
        bm25Index,
        topics,
        topicMatchIds,
      );
      const stage2 = await stage2ApplyFilters(stage1.ids, context);
      if (stage2.hits.length >= TOPIC_FILTER_MIN_RESULTS) {
        logger.debug(
          { query, hitCount: stage2.hits.length },
          'Sub-need Level 1 success: topic-filtered results sufficient',
        );
        return stage2.hits.slice(0, limit).map((h) => ({ tool: h.tool, score: h.score }));
      }
      logger.debug(
        { query, hitCount: stage2.hits.length },
        'Sub-need Level 1 insufficient — falling through to Level 2',
      );
    }

    // ── Level 2: Unfiltered search with topic bonus ────────────────────────
    // Run standard search, but multiply score by 1.5x for tools with topic overlap.
    // This gives domain-relevant tools an advantage without hard-filtering.
    const stage1Unfiltered = await stage1HybridSearch(
      query,
      [],
      undefined,
      { bm25Weight: 1.0, vectorWeight: 1.0 },
      bm25Index,
    );
    const stage2Unfiltered = await stage2ApplyFilters(stage1Unfiltered.ids, context);

    if (topics.length > 0 && topicMatchIds.size > 0) {
      logger.debug(
        { query, topics, matchCount: topicMatchIds.size },
        'Sub-need Level 2: unfiltered + topic bonus',
      );
      const boosted = stage2Unfiltered.hits.map((h) => ({
        tool: h.tool,
        score: topicMatchIds.has(h.tool.id) ? h.score * TOPIC_BONUS_MULTIPLIER : h.score,
      }));
      boosted.sort((a, b) => b.score - a.score);
      return boosted.slice(0, limit);
    }

    // ── Level 3: Pure unfiltered fallback ──────────────────────────────────
    // No topic signals extracted — standard Stage 1+2 pipeline.
    logger.debug({ query }, 'Sub-need Level 3: pure unfiltered search (no topic signals)');
    return stage2Unfiltered.hits.slice(0, limit).map((h) => ({ tool: h.tool, score: h.score }));
  }

  /**
   * Determine which clarification round we're on based on previously asked dimensions.
   * Round 1: topic/usecase clarification
   * Round 2: constraint clarification (deployment, language)
   * Round 3: decisive (is_stable)
   */
  getClarificationRound(askedDimensions: string[]): number {
    if (askedDimensions.length === 0) return 1;
    if (askedDimensions.includes('topics') && !askedDimensions.includes('deployment_model'))
      return 2;
    if (askedDimensions.includes('deployment_model') && !askedDimensions.includes('is_stable'))
      return 3;
    return 4; // All rounds done, proceed to results
  }

  /**
   * Get or build the cached topic vocabulary from the tool corpus.
   * Built once, cached for process lifetime alongside BM25 index.
   */
  async getTopicVocabulary(): Promise<Set<string>> {
    if (_cachedTopicVocab) return _cachedTopicVocab;
    const corpus = await this.getCachedCorpus();
    _cachedTopicVocab = buildTopicVocabulary(corpus);
    logger.info({ vocabSize: _cachedTopicVocab.size }, 'Topic vocabulary cached');
    return _cachedTopicVocab;
  }

  /**
   * Get or load the cached tool corpus for topic operations.
   * Separate from BM25 cache — BM25 only needs the index, topic filtering
   * needs the raw ToolNode[] for topic field access.
   */
  private async getCachedCorpus(): Promise<ToolNode[]> {
    if (_cachedTopicCorpus) return _cachedTopicCorpus;
    _cachedTopicCorpus = await this.loadToolCorpus();
    return _cachedTopicCorpus;
  }

  /**
   * Load the full tool corpus from Qdrant (payload stored at index time).
   * Public so callers (e.g. search_tools handler) can build the BM25 index themselves.
   */
  async loadToolCorpus(): Promise<ToolNode[]> {
    const tools: ToolNode[] = [];
    let offset: string | number | null | undefined = undefined;

    // Paginate through ALL Qdrant points — the old limit:10_000 only loaded
    // the first page, making ~60% of tools invisible to search.
    while (true) {
      const result = await qdrantClient().scroll(COLLECTION_NAME, {
        limit: 10_000,
        offset,
        with_payload: true,
        with_vector: false,
      });

      const points = result.points as Array<{ payload: Record<string, unknown> | null }>;
      tools.push(
        ...points
          .filter((p) => p.payload != null)
          .map((p) => {
            const t = p.payload as unknown as ToolNode;
            // Qdrant payloads may still hold the old Record<string,string> format
            // for package_managers. Normalize to PackageChannel[] so all downstream
            // code (BM25, stage0-exact) can safely call .flatMap / .some on it.
            const raw = t.package_managers as unknown;
            if (!Array.isArray(raw)) {
              t.package_managers =
                raw && typeof raw === 'object'
                  ? Object.entries(raw as Record<string, string>).map(
                      ([registry, pkg]): PackageChannel => ({
                        registry,
                        packageName: pkg,
                        installCommand: '',
                        weeklyDownloads: 0,
                      }),
                    )
                  : [];
            }
            return t;
          }),
      );

      const nextOffset = result.next_page_offset as string | number | null | undefined;
      if (!nextOffset) break;
      offset = nextOffset;
    }

    logger.info({ totalTools: tools.length }, 'Tool corpus loaded from Qdrant');
    return tools;
  }
}

/** Load user tool preferences from Redis sorted set (fire-and-forget safe). */
async function loadUserPreferences(userId: string): Promise<Map<string, number> | undefined> {
  if (!process.env.REDIS_URL) return undefined;
  try {
    const { Redis } = await import('ioredis');
    const redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 0,
    });
    await redis.connect();
    try {
      const raw = await redis.zrangebyscore(
        `user:${userId}:tool_prefs`,
        '-inf',
        '+inf',
        'WITHSCORES',
      );
      const prefs = new Map<string, number>();
      for (let i = 0; i < raw.length - 1; i += 2) {
        prefs.set(raw[i] as string, Number(raw[i + 1]));
      }
      return prefs.size > 0 ? prefs : undefined;
    } finally {
      redis.disconnect();
    }
  } catch {
    return undefined;
  }
}
