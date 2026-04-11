/**
 * Compute inbound edge centrality for all Tool nodes in Memgraph.
 *
 * ecosystem_centrality = number of other Tool nodes with edges pointing TO this tool.
 * High centrality → this tool is widely integrated by the ecosystem (e.g. React, TypeScript).
 * Used in GET_TOOL_GRAPH_RERANK to boost well-connected tools in Stage 3.
 *
 * Run after a full re-index when the graph has fresh edges.
 * Usage: pnpm tsx src/compute-centrality.ts
 */

import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { COLLECTION_NAME, qdrantClient } from '@toolcairn/vector';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/indexer:compute-centrality' });

async function main() {
  const session = getMemgraphSession();
  const client = qdrantClient();

  try {
    logger.info('Computing inbound edge centrality for all Tool nodes...');

    // Set ecosystem_centrality = inbound edge count for every Tool in Memgraph
    const result = await session.run(
      `MATCH (t:Tool)
       WITH t,
            size([(other:Tool)-[]->(t) | other]) AS inbound_count
       SET t.ecosystem_centrality = inbound_count
       RETURN count(t) AS updated, avg(inbound_count) AS avg_centrality, max(inbound_count) AS max_centrality`,
    );

    const record = result.records[0];
    const updated = record?.get('updated');
    const avg = record?.get('avg_centrality');
    const max = record?.get('max_centrality');
    logger.info({ updated, avg, max }, 'Centrality computed in Memgraph');

    // Sync ecosystem_centrality to Qdrant payloads (search pipeline reads from Qdrant)
    logger.info('Syncing centrality to Qdrant payloads...');
    let offset: string | number | null | undefined = undefined;
    let totalSynced = 0;

    while (true) {
      const scrollResult = await client.scroll(COLLECTION_NAME, {
        limit: 500,
        offset,
        with_payload: ['name', 'ecosystem_centrality'],
        with_vector: false,
      });

      const points = scrollResult.points as Array<{
        id: string | number;
        payload: Record<string, unknown> | null;
      }>;

      if (points.length === 0) break;

      // Fetch centrality from Memgraph for each tool in this page
      for (const point of points) {
        if (!point.payload) continue;
        const toolName = point.payload.name as string;
        if (!toolName) continue;

        const centralityResult = await session.run(
          'MATCH (t:Tool {name: $name}) RETURN t.ecosystem_centrality AS centrality',
          { name: toolName },
        );
        const centrality = (centralityResult.records[0]?.get('centrality') as number | null) ?? 0;

        await client.setPayload(COLLECTION_NAME, {
          payload: { ecosystem_centrality: centrality },
          points: [String(point.id)],
        });
        totalSynced++;
      }

      const nextOffset = scrollResult.next_page_offset as string | number | null | undefined;
      if (!nextOffset) break;
      offset = nextOffset;

      if (totalSynced % 2000 === 0) {
        logger.info({ totalSynced }, 'Qdrant sync progress');
      }
    }

    logger.info({ totalSynced }, 'Centrality sync complete');
  } finally {
    await session.close();
    await closeMemgraphDriver();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
