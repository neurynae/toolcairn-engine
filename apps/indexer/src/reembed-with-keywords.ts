/**
 * Re-embed all tools with keyword_sentence included in the embedding text.
 *
 * Tool vectors were originally computed from name+description+topics.
 * keyword_sentence was added later but never included in the embeddings.
 * This script re-computes all vectors with the full text:
 *   name\ndescription\nkeyword_sentence\nTopics: topics
 *
 * Usage: pnpm tsx src/reembed-with-keywords.ts
 */

import { createLogger } from '@toolcairn/errors';
import { COLLECTION_NAME, embedBatch, qdrantClient, toolEmbedText } from '@toolcairn/vector';

const logger = createLogger({ name: '@toolcairn/indexer:reembed-with-keywords' });
const BATCH_SIZE = 50; // Nomic API batch limit
const SCROLL_SIZE = 500;

async function main() {
  const client = qdrantClient();
  let offset: string | number | null | undefined = undefined;
  let processed = 0;
  let updated = 0;
  let failed = 0;

  while (true) {
    const resp = await client.scroll(COLLECTION_NAME, {
      limit: SCROLL_SIZE,
      with_payload: {
        include: ['name', 'description', 'topics', 'keyword_sentence'],
      },
      with_vector: false,
      ...(offset != null ? { offset } : {}),
    });

    const points = resp.points as Array<{
      id: string | number;
      payload: Record<string, unknown> | null;
    }>;

    if (points.length === 0) break;

    // Build embedding texts for this scroll batch
    const items = points.map((p) => {
      const pl = p.payload ?? {};
      return {
        id: String(p.id),
        text: toolEmbedText(
          (pl.name as string) ?? '',
          (pl.description as string) ?? '',
          (pl.topics as string[]) ?? [],
          (pl.keyword_sentence as string) ?? undefined,
        ),
      };
    });

    // Embed in sub-batches of BATCH_SIZE (Nomic limit)
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const texts = batch.map((b) => b.text);

      try {
        const vectors = await embedBatch(texts);

        // Update each point's vector in Qdrant
        const updatePoints = batch.map((b, idx) => ({
          id: b.id,
          vector: vectors[idx] ?? new Array(768).fill(0),
        }));

        await client.upsert(COLLECTION_NAME, {
          wait: true,
          points: updatePoints.map((p) => ({
            id: p.id,
            vector: p.vector,
          })),
        });

        updated += batch.length;
      } catch (err) {
        logger.error({ err, batchStart: i }, 'Batch embedding failed');
        failed += batch.length;
      }
    }

    processed += points.length;
    if (processed % 500 === 0) {
      logger.info({ processed, updated, failed }, 'Re-embedding progress');
    }

    offset = (resp.next_page_offset as string | number | null) ?? null;
    if (!offset) break;
  }

  logger.info({ processed, updated, failed }, 'Re-embedding complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
