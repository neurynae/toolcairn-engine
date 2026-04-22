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
 *   Powers the MCP batch-resolve lookup (toolcairn_init discovery → find the
 *   indexed Tool that owns a given manifest declaration like npm:next).
 */
async function ensureToolsPayloadIndexes(): Promise<void> {
  const client = qdrantClient();
  try {
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'registry_package_keys',
      field_schema: 'keyword',
      wait: true,
    });
  } catch (e) {
    // Qdrant throws on duplicate-index in some versions; swallow + log-agnostic.
    const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
    if (!msg.includes('already exists') && !msg.includes('duplicate')) {
      throw new VectorError({
        message: `Failed to ensure payload index 'registry_package_keys' on '${COLLECTION_NAME}': ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      });
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
