/**
 * Stage 0 — Exact-match resolution (short-circuit).
 *
 * Before the expensive Stage 1 pipeline (BM25 index + vector embedding + Qdrant search),
 * check if the query directly resolves to a known tool via:
 *   1. Package manager canonical name (npm:"react" === query)
 *   2. Tool name exact match (tool.name === query)
 *   3. Name component match (single-word query matches name split by delimiters)
 *
 * Short-circuits only when there's a clear winner — ambiguous matches fall through
 * to the full pipeline where credibility weighting separates candidates.
 */

import type { ToolNode } from '@toolcairn/core';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/search:stage0-exact' });

export interface Stage0Result {
  match: ToolNode | null;
  elapsed_ms: number;
}

/**
 * Build O(1) lookup maps from the tool corpus.
 * Call once per search (or cache if corpus doesn't change between searches).
 */
export interface ExactLookupMaps {
  /** Lowercase package manager name → tools (e.g., "react" → [facebook/react]) */
  byPmName: Map<string, ToolNode[]>;
  /** Lowercase tool name → tools (e.g., "zod" → [colinhacks/zod]) */
  byName: Map<string, ToolNode[]>;
  /** Lowercase name component → tools (e.g., "react" from "facebook/react") */
  byNamePart: Map<string, ToolNode[]>;
}

export function buildExactLookupMaps(tools: ToolNode[]): ExactLookupMaps {
  const byPmName = new Map<string, ToolNode[]>();
  const byName = new Map<string, ToolNode[]>();
  const byNamePart = new Map<string, ToolNode[]>();

  for (const tool of tools) {
    // Package manager names
    for (const pmName of Object.values(tool.package_managers ?? {})) {
      const key = pmName.toLowerCase();
      const arr = byPmName.get(key) ?? [];
      arr.push(tool);
      byPmName.set(key, arr);
    }

    // Full tool name
    const nameKey = tool.name.toLowerCase();
    const nameArr = byName.get(nameKey) ?? [];
    nameArr.push(tool);
    byName.set(nameKey, nameArr);

    // Name parts (split on delimiters)
    const parts = nameKey.split(/[-_./]+/).filter((t) => t.length > 1);
    for (const part of parts) {
      if (part !== nameKey) {
        const partArr = byNamePart.get(part) ?? [];
        partArr.push(tool);
        byNamePart.set(part, partArr);
      }
    }
  }

  return { byPmName, byName, byNamePart };
}

/** Pick the highest-credibility tool from candidates. */
function pickBest(candidates: ToolNode[]): ToolNode {
  return candidates.reduce((best, curr) =>
    (curr.health.credibility_score ?? 0) > (best.health.credibility_score ?? 0) ? curr : best,
  );
}

/**
 * Attempt exact resolution. Returns the matched tool or null.
 *
 * Short-circuit rules:
 * - Package manager exact match: strongest signal, always short-circuits (pick highest credibility)
 * - Tool name exact match: short-circuits if single match or clear credibility winner
 * - Name component match (single-word only): short-circuits only if one dominant candidate
 *   (credibility gap > 0.15 AND the best candidate's PM name matches the query)
 */
export function stage0ExactResolve(query: string, maps: ExactLookupMaps): Stage0Result {
  const t0 = Date.now();
  const q = query.toLowerCase().trim();

  // Multi-word queries are natural language → skip exact resolution
  if (q.includes(' ')) {
    return { match: null, elapsed_ms: Date.now() - t0 };
  }

  // Normalize: strip trailing ".js" (users type "express.js" meaning "express")
  const qNorm = q.replace(/\.js$/, '');

  // Minimum credibility to short-circuit on name/PM match.
  // PM matches bypass this threshold (they're canonical by definition).
  // Name matches require it to prevent low-quality tools with exact names
  // (e.g. nativescript/tailwind) from blocking the real canonical tool.
  const MIN_CRED = 0.7;

  // 1. Package manager canonical name — strongest identity signal, no credibility gate
  const pmMatches = maps.byPmName.get(q) ?? maps.byPmName.get(qNorm) ?? [];
  if (pmMatches.length > 0) {
    const best = pickBest(pmMatches);
    logger.info(
      { tool: best.name, cred: (best.health.credibility_score ?? 0).toFixed(2), via: 'pm_name' },
      'Stage 0 exact match',
    );
    return { match: best, elapsed_ms: Date.now() - t0 };
  }

  // 2. Tool name exact match — only short-circuit if credibility is above threshold
  const nameMatches = maps.byName.get(q) ?? maps.byName.get(qNorm) ?? [];
  if (nameMatches.length > 0) {
    const best = pickBest(nameMatches);
    const bestCred = best.health.credibility_score ?? 0;
    if (bestCred >= MIN_CRED) {
      logger.info(
        { tool: best.name, cred: bestCred.toFixed(2), via: 'name' },
        'Stage 0 exact match',
      );
      return { match: best, elapsed_ms: Date.now() - t0 };
    }
    logger.debug(
      { tool: best.name, cred: bestCred.toFixed(2), threshold: MIN_CRED },
      'Stage 0 name match below credibility threshold — falling through to pipeline',
    );
  }

  // 3. Name component match — only for single-word queries
  const partMatches = maps.byNamePart.get(q) ?? maps.byNamePart.get(qNorm) ?? [];
  if (partMatches.length > 0) {
    const best = pickBest(partMatches);
    const others = partMatches.filter((t) => t !== best);
    const second = others.length > 0 ? pickBest(others) : undefined;

    const bestCred = best.health.credibility_score ?? 0;
    const secondCred = second?.health.credibility_score ?? 0;

    // Short-circuit only if clear winner: credibility gap > 0.15
    // AND best candidate has a package manager name matching the query
    const bestHasPmMatch = Object.values(best.package_managers ?? {}).some(
      (n) => n.toLowerCase() === q || n.toLowerCase() === qNorm,
    );

    if (bestCred - secondCred > 0.15 && bestHasPmMatch) {
      logger.info(
        { tool: best.name, credGap: (bestCred - secondCred).toFixed(2), via: 'name_part_pm' },
        'Stage 0 exact match',
      );
      return { match: best, elapsed_ms: Date.now() - t0 };
    }

    // If there's a huge star gap (10x+), short-circuit even without PM match
    if (best.health.stars > (second?.health.stars ?? 0) * 10) {
      logger.info(
        { tool: best.name, stars: best.health.stars, via: 'name_part_star_dominance' },
        'Stage 0 exact match',
      );
      return { match: best, elapsed_ms: Date.now() - t0 };
    }
  }

  // No clear exact match — fall through to full pipeline
  return { match: null, elapsed_ms: Date.now() - t0 };
}
