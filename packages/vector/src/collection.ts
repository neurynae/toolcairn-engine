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

export async function ensureCollection(): Promise<void> {
  return ensureCollectionByName(COLLECTION_NAME);
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
