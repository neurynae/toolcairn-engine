/**
 * Graph-based query expansion.
 * Extracts known tool entities from the query and fetches their directly
 * integrated tools from Memgraph, pre-boosting them as Stage 1 candidates.
 *
 * Example: query "React state management" → finds "react" as a known tool
 * entity → returns IDs of tools with INTEGRATES_WITH/COMPATIBLE_WITH edges
 * to react. These get prepended to Stage 1 candidates so they always enter
 * Stage 2 even if BM25/vector didn't rank them highly.
 */

import { getMemgraphSession } from '@toolcairn/graph';
import type { ExactLookupMaps } from './stages/stage0-exact.js';

const MAX_ENTITY_EXPANSIONS = 2; // max tool entities to expand per query
const MAX_NEIGHBORS_PER_ENTITY = 20;

/**
 * Find tool entities in the query and fetch their graph neighbors.
 * Returns a list of tool IDs to pre-boost in Stage 1 results.
 * Non-fatal — returns [] on any error or timeout.
 */
export async function expandQueryWithGraphEntities(
  query: string,
  maps: ExactLookupMaps,
): Promise<string[]> {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter((t) => t.length > 1);

  // Find known tool entities in the query (single tokens + 2-token combos)
  const entityNames: string[] = [];
  for (const token of tokens) {
    if (maps.byPmName.has(token) || maps.byName.has(token)) {
      entityNames.push(token);
      if (entityNames.length >= MAX_ENTITY_EXPANSIONS) break;
    }
  }
  // Also try 2-token combinations (e.g. "react native")
  for (let i = 0; i < tokens.length - 1 && entityNames.length < MAX_ENTITY_EXPANSIONS; i++) {
    const pair = `${tokens[i]}-${tokens[i + 1]}`;
    if (maps.byName.has(pair)) entityNames.push(pair);
  }

  if (entityNames.length === 0) return [];

  const expandedIds: string[] = [];
  const session = getMemgraphSession();

  try {
    for (const entityName of entityNames) {
      // Resolve to actual tool name (PM lookup or direct name)
      const candidates = maps.byPmName.get(entityName) ?? maps.byName.get(entityName) ?? [];
      if (candidates.length === 0) continue;
      const toolName = candidates[0]?.name; // use best (highest credibility)
      if (!toolName) continue;

      const result = await session.run(
        `MATCH (t:Tool {name: $name})
         -[:INTEGRATES_WITH|COMPATIBLE_WITH|POPULAR_WITH]->
         (related:Tool)
         RETURN related.id AS id
         LIMIT $limit`,
        { name: toolName, limit: MAX_NEIGHBORS_PER_ENTITY },
      );

      for (const r of result.records) {
        const id = r.get('id') as string | null;
        if (id && !expandedIds.includes(id)) expandedIds.push(id);
      }
    }
  } catch {
    // Non-fatal — graph expansion is a best-effort boost
  } finally {
    await session.close();
  }

  return expandedIds;
}
