// Co-occurrence expansion: given primary facets detected by BM25,
// discover IMPLICIT layers by finding UseCases that commonly co-occur
// on the same tools in the graph.
//
// Example: primary facet "ecommerce" → co-occurring: "payments", "stripe",
// "shopping-cart", "graphql" — layers the user didn't name but every
// e-commerce project needs.

import type { MemgraphUseCaseRepository } from '@toolcairn/graph';

/**
 * Expand a set of primary facets with co-occurring UseCases from the graph.
 *
 * For each primary facet, tools that SOLVE it also SOLVE other UseCases.
 * The most frequent "other" UseCases are the implicit layers of a stack
 * in that domain — data-driven, not keyword-mapped.
 *
 * Returns the COMBINED list: primary facets first, then co-occurring facets,
 * deduplicated. Capped at `maxTotal` to bound query count.
 */
export async function expandWithCooccurrence(
  primaryFacets: string[],
  usecaseRepo: MemgraphUseCaseRepository,
  cooccurrenceLimit = 12,
  maxTotal = 16,
): Promise<string[]> {
  if (primaryFacets.length === 0) return [];

  const result = await usecaseRepo.getCooccurringUseCases(primaryFacets, cooccurrenceLimit);
  const cooccurring = result.ok ? result.data : [];

  // Combine primary + co-occurring, deduped, primary first
  const seen = new Set(primaryFacets);
  const expanded = [...primaryFacets];

  for (const { name } of cooccurring) {
    if (seen.has(name)) continue;
    seen.add(name);
    expanded.push(name);
    if (expanded.length >= maxTotal) break;
  }

  return expanded;
}
