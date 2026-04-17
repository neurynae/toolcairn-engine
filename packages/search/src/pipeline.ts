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
    const { extractLanguagesFromQuery: extractLangs } = await import('./language-concordance.js');
    const targetLanguages = extractLangs(query);

    // Precompute topic-matching tool IDs from cached corpus
    const corpus = await this.getCachedCorpus();
    const topicMatchIds =
      topics.length > 0 ? computeTopicMatchIds(corpus, topics) : new Set<string>();

    // ── Level 1: Topic-filtered search ─────────────────────────────────────
    if (topics.length > 0 && topicMatchIds.size >= TOPIC_FILTER_MIN_POOL) {
      logger.debug(
        { query, topics, targetLanguages, matchCount: topicMatchIds.size },
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
        targetLanguages,
        corpus,
      );
      const stage2 = await stage2ApplyFilters(stage1.ids, context, stage1.scores);
      if (stage2.hits.length >= TOPIC_FILTER_MIN_RESULTS) {
        const results = await this.applyGraphMultiplier(stage2.hits);
        logger.debug(
          { query, hitCount: results.length },
          'Sub-need Level 1 success: topic-filtered + graph multiplied',
        );
        return results.slice(0, limit);
      }
      logger.debug(
        { query, hitCount: stage2.hits.length },
        'Sub-need Level 1 insufficient — falling through to Level 2',
      );
    }

    // ── Level 2: Unfiltered search (no topic bonus — topics already served as filter) ──
    const stage1Unfiltered = await stage1HybridSearch(
      query,
      [],
      undefined,
      { bm25Weight: 1.0, vectorWeight: 1.0 },
      bm25Index,
      undefined,
      undefined,
      targetLanguages,
      corpus,
    );
    const stage2Unfiltered = await stage2ApplyFilters(
      stage1Unfiltered.ids,
      context,
      stage1Unfiltered.scores,
    );

    // ── Level 2: Unfiltered + graph multiplier ─────────────────────────────
    // Tools compete on description match + credibility + graph connectivity.
    const results = await this.applyGraphMultiplier(stage2Unfiltered.hits);
    logger.debug({ query, targetLanguages }, 'Sub-need Level 2: unfiltered + graph multiplied');
    return results.slice(0, limit);
  }

  /**
   * Keyword-sentence search with BM25→vector fallback.
   *
   * Implements its own Stage 1 instead of delegating to stage1HybridSearch,
   * because keyword search needs:
   * 1. Keyword-aware BM25 tokenization (compounds preserved as single tokens)
   * 2. Vector fallback when BM25 can't match compounds (if BM25 is weak,
   *    vector results are appended to the BM25 ranked list as a safety net)
   * 3. RRF at 1.2:0.8 (slight BM25 favor — field weight 4.0 already dominates)
   *
   * Flow: BM25 → [vector fallback if weak] → vector search → RRF 1.2:0.8
   *       → language concordance → relevance scores → Stage 2
   */
  async runKeywordSearch(
    keywordSentence: string,
    context: SearchContext | undefined,
    limit: number,
  ): Promise<ToolScoredResult[]> {
    const bm25Index = await getCachedBm25Index(this);
    const corpus = await this.getCachedCorpus();

    // ── BM25 search ────────────────────────────────────────────────────
    const {
      bm25Search,
      embedText,
      qdrantClient: getClient,
      COLLECTION_NAME: collection,
      rrfFusion,
    } = await import('@toolcairn/vector');
    const bm25Results = bm25Search(keywordSentence, bm25Index);
    const bm25Ids = bm25Results.map((r) => r.id);

    // BM25 score normalization (min-max instead of saturation).
    // Saturation score/(score+median) compresses all high scores to 0.95+,
    // destroying the 2x score advantage that 11/11 keyword matches should
    // have over 3/11 matches. Min-max preserves the actual score ratios.
    const normalizedBm25 = new Map<string, number>();
    if (bm25Results.length > 0) {
      const maxBm25 = bm25Results[0]?.score ?? 1; // already sorted desc
      const minBm25 = bm25Results[bm25Results.length - 1]?.score ?? 0;
      const bm25Range = maxBm25 - minBm25 || 1;
      for (const r of bm25Results) {
        normalizedBm25.set(r.id, (r.score - minBm25) / bm25Range);
      }
    }

    // ── Vector search (Nomic embed + Qdrant) ───────────────────────────
    let queryVector: number[] | null = null;
    try {
      queryVector = await embedText(keywordSentence, 'search_query');
    } catch {
      // No NOMIC_API_KEY — BM25-only mode
    }

    const vectorIds: string[] = [];
    const rawVectorScores = new Map<string, number>();
    if (queryVector) {
      try {
        const vectorResults = await getClient().search(collection, {
          vector: queryVector,
          limit: 150,
          with_payload: false,
        });
        for (const r of vectorResults as Array<{
          id: string | number;
          score: number;
        }>) {
          vectorIds.push(String(r.id));
          rawVectorScores.set(String(r.id), r.score);
        }
      } catch {
        // Vector search unavailable — BM25-only mode
      }
    }

    // Vector score normalization (min-max)
    const normalizedVector = new Map<string, number>();
    if (rawVectorScores.size > 0) {
      const vals = [...rawVectorScores.values()];
      const minV = Math.min(...vals);
      const range = Math.max(...vals) - minV || 1;
      for (const [id, s] of rawVectorScores) {
        normalizedVector.set(id, (s - minV) / range);
      }
    }

    // ── BM25→vector fallback ───────────────────────────────────────────
    // If BM25 top score is weak (compound keywords didn't match), append
    // high-confidence vector results to the BM25 ranked list so they get
    // a chance in the BM25 leg of RRF. Only tools with cosine similarity
    // ≥ 0.65 are included — this filters noise while catching genuine
    // semantic matches for compound keywords BM25 couldn't tokenize.
    const BM25_WEAK_THRESHOLD = 2.0;
    const VECTOR_FALLBACK_MIN_SIMILARITY = 0.65;
    const topBm25Raw = bm25Results[0]?.score ?? 0;
    let effectiveBm25Ids = bm25Ids;
    if (topBm25Raw < BM25_WEAK_THRESHOLD && vectorIds.length > 0) {
      const bm25IdSet = new Set(bm25Ids);
      const fallbackIds = vectorIds.filter(
        (id) =>
          !bm25IdSet.has(id) && (rawVectorScores.get(id) ?? 0) >= VECTOR_FALLBACK_MIN_SIMILARITY,
      );
      effectiveBm25Ids = [...bm25Ids, ...fallbackIds];
      logger.debug(
        { topBm25Raw, fallbackCount: fallbackIds.length },
        'BM25 weak — appending high-confidence vector fallback to BM25 list',
      );
    }

    // ── RRF fusion at 1.2:0.8 (slight BM25 favor) ─────────────────────
    const fused =
      vectorIds.length > 0
        ? rrfFusion([effectiveBm25Ids, vectorIds], [1.2, 0.8])
        : effectiveBm25Ids;

    // ── Combined relevance: (b² + v²) / (b + v) ───────────────────────
    const relevanceScores = new Map<string, number>();
    const allScoredIds = new Set([...normalizedBm25.keys(), ...normalizedVector.keys()]);
    for (const id of allScoredIds) {
      const b = normalizedBm25.get(id) ?? 0;
      const v = normalizedVector.get(id) ?? 0;
      const sum = b + v;
      relevanceScores.set(id, sum > 0 ? (b * b + v * v) / sum : 0);
    }

    // ── Language concordance penalty ───────────────────────────────────
    const { extractLanguagesFromQuery: extractLangs, computeLangConcordance } = await import(
      './language-concordance.js'
    );
    const targetLanguages = extractLangs(keywordSentence);
    if (targetLanguages.length > 0) {
      const toolMap = new Map(corpus.map((t) => [t.id, t]));
      for (const [id, score] of relevanceScores) {
        const tool = toolMap.get(id);
        if (tool) {
          const concordance = computeLangConcordance(
            tool.language,
            tool.languages ?? [],
            targetLanguages,
          );
          relevanceScores.set(id, score * concordance);
        }
      }
    }

    // ── Stage 2: credibility scoring ───────────────────────────────────
    const stage2 = await stage2ApplyFilters(fused, context, relevanceScores);

    // No graph multiplier for keyword search — keyword relevance IS the
    // primary signal. Graph verification (REPLACES/INTEGRATES_WITH/REQUIRES)
    // is handled in Stage 3 by the get_stack handler. The graph multiplier
    // amplifies hub tools (React, Node.js) via connectivity, which overwhelms
    // keyword match scores for less-connected but precisely matching tools.
    logger.debug(
      { keywordSentence: keywordSentence.slice(0, 80), hitCount: stage2.hits.length },
      'Keyword search complete',
    );
    return stage2.hits.map((h) => ({ tool: h.tool, score: h.score })).slice(0, limit);
  }

  /**
   * Query Memgraph for live graph connectivity scores and apply as a multiplier
   * on Stage 2 results. Uses the same Cypher query as Stage 3 (edge weights,
   * use-case overlap, centrality, pagerank) but applies as a multiplicative
   * boost (1.0–2.0×) instead of replacing the score with an additive formula.
   *
   * Zero graph connectivity = 1.0× (Stage 2 score unchanged).
   * High graph connectivity = up to 2.0× (doubles the score).
   */
  private async applyGraphMultiplier(
    hits: Array<{ tool: ToolNode; score: number }>,
  ): Promise<ToolScoredResult[]> {
    if (hits.length === 0) return [];

    const names = hits.map((h) => h.tool.name);
    let graphScores: Map<string, number>;

    try {
      const { GET_TOOL_GRAPH_RERANK, getMemgraphSession, mapRecordToToolNodeWithScore } =
        await import('@toolcairn/graph');
      const session = getMemgraphSession();
      try {
        const result = await session.run(GET_TOOL_GRAPH_RERANK.text, { names });
        graphScores = new Map(
          result.records.map((r) => {
            const { tool, graphScore } = mapRecordToToolNodeWithScore(r.toObject());
            return [tool.name, graphScore];
          }),
        );
      } finally {
        await session.close();
      }
    } catch (e) {
      // Memgraph unavailable — return Stage 2 results unchanged
      logger.warn({ err: e }, 'Graph multiplier: Memgraph query failed — skipping');
      return hits.map((h) => ({ tool: h.tool, score: h.score }));
    }

    // Extract PURE edge connectivity by subtracting the static centrality/pagerank
    // component that Memgraph's query adds (centrality×0.1 + pagerank×0.15).
    // These static signals are already handled by computeGraphBoost in Stage 2 —
    // double-counting them here lets hub tools (next.js) overwhelm specialized
    // tools (docusaurus) even when hubs have no edges to other candidates.
    const pureEdgeScores: number[] = [];
    const toolEdgeMap = new Map<string, number>();
    for (const h of hits) {
      const rawGraph = graphScores.get(h.tool.name) ?? 0;
      const rawCentrality = h.tool.ecosystem_centrality;
      const centrality =
        typeof rawCentrality === 'number'
          ? rawCentrality
          : ((rawCentrality as { low?: number })?.low ?? 0);
      const pagerank = h.tool.pagerank_score ?? 0;
      const staticComponent = centrality * 0.1 + pagerank * 0.15;
      const pureEdge = Math.max(0, rawGraph - staticComponent);
      toolEdgeMap.set(h.tool.name, pureEdge);
      if (pureEdge > 0) pureEdgeScores.push(pureEdge);
    }

    // Saturation normalization: score / (score + median). Self-calibrating —
    // median comes from the actual data, no hardcoded constants.
    // Result: 0 edges → 0, median edges → 0.5, high edges → ~0.8-0.9
    const sorted = pureEdgeScores.sort((a, b) => a - b);
    const median = sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] ?? 1) : 1;
    const saturationK = Math.max(median, 0.5); // floor at 0.5 to avoid div-by-tiny

    const results: ToolScoredResult[] = hits.map((h) => {
      const pureEdge = toolEdgeMap.get(h.tool.name) ?? 0;
      const saturated = pureEdge / (pureEdge + saturationK);
      // Multiplier: 1.0 (no edges to candidates) to 2.0 (heavily connected)
      const multiplier = 1.0 + saturated;
      return { tool: h.tool, score: h.score * multiplier };
    });

    results.sort((a, b) => b.score - a.score);
    return results;
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
