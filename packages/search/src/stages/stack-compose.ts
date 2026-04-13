// Stack composition — greedy set-cover with UseCase coverage + integration affinity.
// Transforms a relevance-ranked candidate list into a complementary tool stack.

import type { PairwiseEdge } from '@toolcairn/graph';
import type { ToolScoredResult } from '../types.js';

// ─── Tuning constants (math weights, not keyword rules) ─────────────────────

/**
 * Boost multiplier when a candidate covers UseCases not yet in the stack.
 * At 1.0, a tool covering 100% new UseCases gets a 2× multiplier — strong enough
 * to prefer a database tool (0.65 base) over a second auth tool (0.85 base)
 * when building a diverse stack.
 */
const COVERAGE_BONUS = 1.0;

/** Penalty when ALL of a candidate's UseCases are already covered by the stack. */
const DUPLICATE_PENALTY = 0.15;

/** Penalty for REPLACES edges — tools that are alternatives. */
const REPLACES_PENALTY = 0.15;

/** Penalty for CONFLICTS_WITH edges — tools that conflict. */
const CONFLICTS_PENALTY = 0.05;

/**
 * Bonus for covering a PRIMARY FACET (query-derived layer) not yet in the stack.
 * This is the key to diversity: "database" (new layer) must beat "ldap" (sub-feature
 * of already-covered "authentication" layer). Without this, tools with many
 * fine-grained UseCases in the same domain always outscore tools from new domains.
 */
const PRIMARY_LAYER_BONUS = 4.0;

// ─── Edge affinity multipliers ──────────────────────────────────────────────

const EDGE_MULTIPLIERS: Record<string, number> = {
  INTEGRATES_WITH: 0.3,
  COMPATIBLE_WITH: 0.2,
  POPULAR_WITH: 0.1,
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ComposedStack {
  tools: Array<ToolScoredResult & { role: string }>;
  integrationNotes: string[];
}

type EdgeMap = Map<string, PairwiseEdge[]>;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Symmetric edge key — order-independent. */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

/** Build a symmetric lookup: key = "toolA||toolB" → edges between them. */
function buildEdgeMap(edges: PairwiseEdge[]): EdgeMap {
  const map: EdgeMap = new Map();
  for (const edge of edges) {
    const key = edgeKey(edge.source, edge.target);
    const existing = map.get(key);
    if (existing) {
      existing.push(edge);
    } else {
      map.set(key, [edge]);
    }
  }
  return map;
}

function lookupEdges(edgeMap: EdgeMap, a: string, b: string): PairwiseEdge[] {
  return edgeMap.get(edgeKey(a, b)) ?? [];
}

/** Capitalize first letter, replace hyphens with spaces. */
function formatRole(useCaseName: string): string {
  const cleaned = useCaseName.replace(/-/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Resolve the UseCase set for a candidate.
 * Priority: SOLVES edges → tool.topics → empty (no modifier applied).
 */
function resolveUseCases(
  toolName: string,
  topics: string[],
  toolUseCases: Map<string, string[]>,
): string[] {
  const fromGraph = toolUseCases.get(toolName);
  if (fromGraph && fromGraph.length > 0) return fromGraph;
  if (topics.length > 0) return topics;
  return [];
}

// ─── Main algorithm ─────────────────────────────────────────────────────────

/**
 * Compose a complementary tool stack from a ranked candidate pool.
 *
 * Uses greedy set-cover: at each step, pick the candidate that maximizes
 * a composite of base relevance, new UseCase coverage, integration affinity,
 * and REPLACES/CONFLICTS penalties.
 */
export function composeStack(
  candidates: ToolScoredResult[],
  toolUseCases: Map<string, string[]>,
  pairwiseEdges: PairwiseEdge[],
  limit: number,
  facetProvenance?: Map<string, string>,
  primaryFacets?: string[],
): ComposedStack {
  if (candidates.length === 0) {
    return { tools: [], integrationNotes: [] };
  }

  const edgeMap = buildEdgeMap(pairwiseEdges);
  const coveredUseCases = new Set<string>();
  const coveredPrimaryFacets = new Set<string>();
  const primaryFacetSet = new Set(primaryFacets ?? []);
  const stack: Array<ToolScoredResult & { role: string }> = [];
  const remaining = new Set(candidates.map((_, i) => i));

  for (let slot = 0; slot < limit && remaining.size > 0; slot++) {
    let bestIdx = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRole = '';

    for (const idx of remaining) {
      // biome-ignore lint/style/noNonNullAssertion: idx is from candidates array bounds
      const candidate = candidates[idx]!;
      let score = candidate.score;

      // ── Two-tier coverage: primary facets first, then UseCase sub-features ──
      const myUseCases = resolveUseCases(candidate.tool.name, candidate.tool.topics, toolUseCases);

      // Tier 1: Does this tool cover a PRIMARY LAYER the stack doesn't have yet?
      // "database" (new layer) is worth massively more than "ldap" (sub-feature of auth).
      const newPrimaryLayers = myUseCases.filter(
        (uc) => primaryFacetSet.has(uc) && !coveredPrimaryFacets.has(uc),
      );

      if (newPrimaryLayers.length > 0) {
        // Covers a required stack layer — strong boost
        score *= PRIMARY_LAYER_BONUS;
      } else {
        // Tier 2: No new primary layer — fall back to UseCase-level coverage
        const newUseCases = myUseCases.filter((uc) => !coveredUseCases.has(uc));
        if (newUseCases.length > 0) {
          score *= 1 + COVERAGE_BONUS * (newUseCases.length / myUseCases.length);
        } else if (myUseCases.length > 0) {
          score *= DUPLICATE_PENALTY;
        }
      }

      // ── Graph edge signals ──
      for (const member of stack) {
        const edges = lookupEdges(edgeMap, candidate.tool.name, member.tool.name);
        for (const edge of edges) {
          if (edge.edgeType === 'REPLACES') {
            score *= REPLACES_PENALTY;
          } else if (edge.edgeType === 'CONFLICTS_WITH') {
            score *= CONFLICTS_PENALTY;
          } else {
            const multiplier = EDGE_MULTIPLIERS[edge.edgeType] ?? 0;
            if (multiplier > 0) {
              score *= 1 + multiplier * edge.effectiveWeight;
            }
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
        // Role priority: primary facet covered → facet provenance → first UseCase → category
        const facetRole = facetProvenance?.get(candidate.tool.name);
        bestRole =
          newPrimaryLayers.length > 0
            ? formatRole(newPrimaryLayers[0] as string)
            : facetRole
              ? formatRole(facetRole)
              : myUseCases.length > 0
                ? formatRole(myUseCases[0] as string)
                : formatRole(candidate.tool.category);
      }
    }

    if (bestIdx < 0) break;

    // biome-ignore lint/style/noNonNullAssertion: bestIdx validated above
    const selected = candidates[bestIdx]!;
    const selectedUseCases = resolveUseCases(
      selected.tool.name,
      selected.tool.topics,
      toolUseCases,
    );
    for (const uc of selectedUseCases) {
      coveredUseCases.add(uc);
      if (primaryFacetSet.has(uc)) coveredPrimaryFacets.add(uc);
    }

    stack.push({ ...selected, role: bestRole });
    remaining.delete(bestIdx);
  }

  // Build integration notes from edges between selected stack members
  const integrationNotes = buildIntegrationNotes(stack, edgeMap);

  return { tools: stack, integrationNotes };
}

// ─── Integration notes ──────────────────────────────────────────────────────

function buildIntegrationNotes(
  stack: Array<ToolScoredResult & { role: string }>,
  edgeMap: EdgeMap,
): string[] {
  const notes: string[] = [];
  for (let i = 0; i < stack.length; i++) {
    for (let j = i + 1; j < stack.length; j++) {
      // biome-ignore lint/style/noNonNullAssertion: loop bounds are valid
      const a = stack[i]!;
      // biome-ignore lint/style/noNonNullAssertion: loop bounds are valid
      const b = stack[j]!;
      const edges = lookupEdges(edgeMap, a.tool.name, b.tool.name);
      for (const edge of edges) {
        if (edge.edgeType === 'INTEGRATES_WITH') {
          notes.push(`${a.tool.display_name} integrates with ${b.tool.display_name}`);
        } else if (edge.edgeType === 'COMPATIBLE_WITH') {
          notes.push(`${a.tool.display_name} is compatible with ${b.tool.display_name}`);
        }
      }
    }
  }
  return notes;
}
