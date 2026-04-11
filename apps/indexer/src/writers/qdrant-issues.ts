import { config } from '@toolcairn/config';
import { createLogger } from '@toolcairn/errors';
import { ISSUES_COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { embedText } from '@toolcairn/vector';
import type { GitHubIssue } from '../crawlers/github-issues.js';
import { IndexerError } from '../errors.js';

const logger = createLogger({ name: '@toolcairn/indexer:qdrant-issues-writer' });

const VECTOR_SIZE = 768;
const BATCH_SIZE = 25;

function issueEmbedText(issue: GitHubIssue): string {
  return `${issue.title}\n${issue.body}`;
}

/**
 * Embed and upsert a batch of GitHubIssues into the Qdrant 'issues' collection.
 * Falls back to zero-vectors when NOMIC_API_KEY is absent so payloads are still
 * stored and the BM25 fallback in check_issue can search by keyword.
 */
export async function upsertIssueVectors(issues: GitHubIssue[]): Promise<void> {
  if (issues.length === 0) return;

  const client = qdrantClient();

  if (!config.NOMIC_API_KEY) {
    logger.warn(
      { count: issues.length },
      'NOMIC_API_KEY absent — writing issues with zero vectors (BM25 fallback only)',
    );
    const zeroVector = new Array(VECTOR_SIZE).fill(0);
    for (let i = 0; i < issues.length; i += BATCH_SIZE) {
      const batch = issues.slice(i, i + BATCH_SIZE);
      try {
        await client.upsert(ISSUES_COLLECTION_NAME, {
          points: batch.map((issue) => ({
            id: issue.id,
            vector: zeroVector,
            payload: issue as unknown as Record<string, unknown>,
          })),
        });
      } catch (e) {
        const detail = (e as { data?: unknown })?.data;
        throw new IndexerError({
          message: `Failed to upsert issue vectors (zero) batch ${i}: ${e instanceof Error ? e.message : String(e)}${detail ? ` | qdrant: ${JSON.stringify(detail)}` : ''}`,
          cause: e,
        });
      }
    }
    return;
  }

  // Embed in batches and upsert
  for (let i = 0; i < issues.length; i += BATCH_SIZE) {
    const batch = issues.slice(i, i + BATCH_SIZE);
    try {
      const vectors = await Promise.all(
        batch.map((issue) => embedText(issueEmbedText(issue), 'search_document')),
      );
      await client.upsert(ISSUES_COLLECTION_NAME, {
        points: batch.map((issue, idx) => ({
          id: issue.id,
          vector: vectors[idx] ?? [],
          payload: issue as unknown as Record<string, unknown>,
        })),
      });
      logger.debug(
        { toolName: batch[0]?.tool_name, batchStart: i, batchSize: batch.length },
        'Issue batch upserted',
      );
    } catch (e) {
      throw new IndexerError({
        message: `Failed to upsert issue vectors for batch starting at ${i}: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      });
    }
  }
}
