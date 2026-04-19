import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MemgraphToolRepository } from '@toolcairn/graph';

/** Normalize a tool name for fuzzy matching — strips dots, hyphens, underscores, spaces, @ */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[@.\-_\s]/g, '');
}

/**
 * Resolve a user-supplied tool name to its canonical indexed name.
 *
 * Ranked matching:
 *   1. Exact-string match (fast path via findByName)
 *   2. Exact normalized match (e.g. "nextjs" → "next.js" — both normalize to "nextjs")
 *   3. Prefix match — the candidate's normalized name starts with the query
 *   4. Substring match — the candidate's normalized name contains the query
 *
 * Candidates within a rank tier are ordered by normalized-length ascending so
 * shorter, more "canonical" names win over long derivatives (e.g. "next" beats
 * "Next-JS-Landing-Page-Starter-Template" when resolving "nextjs").
 *
 * Reverse-substring matching (query contains candidate name) is intentionally
 * dropped — it caused short common words like "act" to win queries like
 * "react-dom" via coincidental letter overlap.
 */
export async function resolveToolName(
  name: string,
  graphRepo: Pick<InstanceType<typeof MemgraphToolRepository>, 'getAllToolNames' | 'findByName'>,
): Promise<string> {
  const exact = await graphRepo.findByName(name);
  if (exact.ok && exact.data != null) return name;

  const all = await graphRepo.getAllToolNames();
  if (!all.ok) return name;

  const qNorm = normalizeName(name);
  if (!qNorm) return name;

  const exactNormalized: string[] = [];
  const prefixMatches: string[] = [];
  const substringMatches: string[] = [];

  for (const candidate of all.data) {
    const cNorm = normalizeName(candidate);
    if (!cNorm) continue;
    if (cNorm === qNorm) exactNormalized.push(candidate);
    else if (cNorm.startsWith(qNorm)) prefixMatches.push(candidate);
    else if (cNorm.includes(qNorm)) substringMatches.push(candidate);
  }

  // Prefer shorter normalized names within each tier.
  const sortByLen = (xs: string[]) =>
    xs.sort((a, b) => normalizeName(a).length - normalizeName(b).length)[0];

  return (
    sortByLen(exactNormalized) ?? sortByLen(prefixMatches) ?? sortByLen(substringMatches) ?? name
  );
}

export function okResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
  };
}

export function errResult(error: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error, message }) }],
    isError: true,
  };
}
