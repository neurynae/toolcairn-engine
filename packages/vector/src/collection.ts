import { qdrantClient } from './client.js';
import { VectorError } from './errors.js';

export const COLLECTION_NAME = 'tools';
export const ISSUES_COLLECTION_NAME = 'issues';
const VECTOR_SIZE = 768;

async function ensureCollectionByName(name: string): Promise<void> {
  const client = qdrantClient();
  try {
    const { collections } = await client.getCollections();
    const exists = collections.some((c) => c.name === name);
    if (!exists) {
      await client.createCollection(name, {
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      });
    }
  } catch (e) {
    throw new VectorError({
      message: `Failed to ensure Qdrant collection '${name}': ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

/**
 * Payload indexes required for filter-heavy queries against the tools collection.
 * Creating a payload index is idempotent — Qdrant skips silently when it exists,
 * so this is safe to call on every startup.
 *
 * - `registry_package_keys`: keyword-array of "<registry>:<packageName>" strings.
 *   Tier 1 of the MCP batch-resolve lookup — canonical registry identity.
 * - `github_url`: single keyword string per point. Tier 2 fallback when the
 *   registry key misses (covers tools whose `package_managers` is incomplete)
 *   and primary key when the MCP client provides a repository URL extracted
 *   from the installed package's own manifest.
 */
async function ensureToolsPayloadIndexes(): Promise<void> {
  const client = qdrantClient();
  const indexes: Array<{ field_name: string; field_schema: 'keyword' }> = [
    { field_name: 'registry_package_keys', field_schema: 'keyword' },
    { field_name: 'github_url', field_schema: 'keyword' },
  ];
  for (const idx of indexes) {
    try {
      await client.createPayloadIndex(COLLECTION_NAME, { ...idx, wait: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
      if (!msg.includes('already exists') && !msg.includes('duplicate')) {
        throw new VectorError({
          message: `Failed to ensure payload index '${idx.field_name}' on '${COLLECTION_NAME}': ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        });
      }
    }
  }
}

export async function ensureCollection(): Promise<void> {
  await ensureCollectionByName(COLLECTION_NAME);
  await ensureToolsPayloadIndexes();
}

/**
 * Ensures the 'issues' collection exists in Qdrant.
 * Used by Phase 5 (Issue Intelligence) for semantic issue search.
 * Payload schema: { tool_name, issue_number, title, body, state, labels, github_url, created_at }
 */
export async function ensureIssuesCollection(): Promise<void> {
  return ensureCollectionByName(ISSUES_COLLECTION_NAME);
}

/** Ensure both collections exist (call on startup). */
export async function ensureAllCollections(): Promise<void> {
  await Promise.all([ensureCollection(), ensureIssuesCollection()]);
}
