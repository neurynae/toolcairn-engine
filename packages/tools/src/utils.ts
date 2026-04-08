import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MemgraphToolRepository } from '@toolcairn/graph';

/** Normalize a tool name for fuzzy matching — strips dots, hyphens, underscores, spaces, @ */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[@.\-_\s]/g, '');
}

/**
 * Resolve a user-supplied tool name to its canonical indexed name.
 * Tries exact match first, then falls back to fuzzy normalized match.
 * Returns the canonical name, or the original if no match found.
 */
export async function resolveToolName(
  name: string,
  graphRepo: Pick<InstanceType<typeof MemgraphToolRepository>, 'getAllToolNames' | 'findByName'>,
): Promise<string> {
  // 1. Exact match — fast path
  const exact = await graphRepo.findByName(name);
  if (exact.ok && exact.data != null) return name;

  // 2. Fuzzy — load all names and find closest normalized match
  const all = await graphRepo.getAllToolNames();
  if (!all.ok) return name;

  const qNorm = normalizeName(name);
  // Prefer prefix match, then substring
  const prefixMatch = all.data.find((n) => normalizeName(n).startsWith(qNorm));
  if (prefixMatch) return prefixMatch;
  const subMatch = all.data.find(
    (n) => normalizeName(n).includes(qNorm) || qNorm.includes(normalizeName(n)),
  );
  return subMatch ?? name;
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
