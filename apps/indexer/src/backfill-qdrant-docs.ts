/**
 * Sync docs links from Memgraph → Qdrant payloads.
 *
 * The search pipeline reads ToolNode data entirely from Qdrant payloads.
 * After running backfill-docs-links.ts (which updated Memgraph), this script
 * propagates the new docs_url and changelog_url into Qdrant's payload store
 * using setPayload (partial update — does not touch vectors).
 *
 * Usage: pnpm tsx src/backfill-qdrant-docs.ts
 */

import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import pino from 'pino';

const logger = pino({ name: '@toolcairn/indexer:backfill-qdrant-docs' });
const PAGE_SIZE = 500;

async function main() {
  const session = getMemgraphSession();
  const client = qdrantClient();

  let offset = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  try {
    while (true) {
      // Fetch a page of tools from Memgraph with their docs fields
      const result = await session.run(
        `MATCH (t:Tool)
         WHERE t.docs_docs_url IS NOT NULL OR t.docs_changelog_url IS NOT NULL
         RETURN t.name AS name,
                t.docs_readme_url AS readme_url,
                t.docs_docs_url AS docs_url,
                t.docs_api_url AS api_url,
                t.docs_changelog_url AS changelog_url
         SKIP $offset LIMIT $limit`,
        { offset, limit: PAGE_SIZE },
      );

      if (result.records.length === 0) break;

      // Update Qdrant payload for each tool in this page
      const updates = result.records.map((r) => ({
        name: r.get('name') as string,
        docs: {
          readme_url: (r.get('readme_url') as string | null) ?? undefined,
          docs_url: (r.get('docs_url') as string | null) ?? undefined,
          api_url: (r.get('api_url') as string | null) ?? undefined,
          changelog_url: (r.get('changelog_url') as string | null) ?? undefined,
        },
      }));

      // Qdrant setPayload with filter per tool (batched individually — no bulk filter-by-name API)
      let pageUpdated = 0;
      for (const update of updates) {
        try {
          await client.setPayload(COLLECTION_NAME, {
            payload: { docs: update.docs },
            filter: {
              must: [{ key: 'name', match: { value: update.name } }],
            },
          });
          pageUpdated++;
        } catch (e) {
          logger.warn({ tool: update.name, err: e }, 'setPayload failed — skipping');
          totalSkipped++;
        }
      }

      totalUpdated += pageUpdated;
      offset += PAGE_SIZE;

      logger.info({ offset, pageSize: result.records.length, totalUpdated }, 'Page processed');
    }

    logger.info({ totalUpdated, totalSkipped }, 'Qdrant docs backfill complete');
  } finally {
    await session.close();
    await closeMemgraphDriver();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
