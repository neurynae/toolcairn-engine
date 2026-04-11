/**
 * Seed runner — reads initial-tools.json, skips already-indexed tools by
 * querying Memgraph, then indexes the rest one at a time.
 *
 * Usage:
 *   tsx src/run-seed.ts
 *
 * Env:
 *   SKIP_EXISTING=0   (default 1) — set to 0 to re-index everything
 *   START_AT=owner/repo            — resume from a specific tool
 *   DRY_RUN=1                      — print what would be indexed without doing it
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { createLogger } from '@toolcairn/errors';
import { handleIndexJob } from './queue-consumers/index-consumer.js';

const logger = createLogger({ name: '@toolcairn/indexer:run-seed' });

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SeedFile {
  version: string;
  description: string;
  tools: string[];
}

/** Fetch already-indexed github_url values from Memgraph. */
async function fetchIndexedGithubUrls(): Promise<Set<string>> {
  const session = getMemgraphSession();
  try {
    const result = await session.run('MATCH (t:Tool) RETURN t.github_url AS url');
    const urls = new Set<string>();
    for (const record of result.records) {
      const url = record.get('url') as string | null;
      if (url) urls.add(url);
    }
    return urls;
  } finally {
    await session.close();
  }
}

/**
 * Normalise a toolId to a GitHub URL for comparison with stored values.
 * Handles "owner/repo" and full "https://github.com/owner/repo" formats.
 */
function toolIdToGithubUrl(toolId: string): string {
  if (toolId.startsWith('https://github.com/') || toolId.startsWith('http://github.com/')) {
    return toolId.replace(/\/$/, '');
  }
  // "owner/repo" — skip npm:/pypi:/cargo: prefixed entries (non-GitHub)
  if (toolId.includes(':')) return toolId;
  return `https://github.com/${toolId}`;
}

async function main(): Promise<void> {
  const skipExisting = process.env.SKIP_EXISTING !== '0';
  const startAt = process.env.START_AT ?? null;
  const dryRun = process.env.DRY_RUN === '1';

  // Load seed list
  const seedPath = join(__dirname, 'seed', 'initial-tools.json');
  const seedFile = JSON.parse(readFileSync(seedPath, 'utf-8')) as SeedFile;
  const allTools = seedFile.tools;

  logger.info({ total: allTools.length, skipExisting, dryRun }, 'Seed runner starting');

  // Fetch already-indexed tools from Memgraph
  let indexedUrls = new Set<string>();
  if (skipExisting) {
    logger.info('Querying Memgraph for already-indexed tools…');
    try {
      indexedUrls = await fetchIndexedGithubUrls();
      logger.info({ indexed: indexedUrls.size }, 'Found already-indexed tools');
    } catch (err) {
      logger.warn({ err }, 'Could not query Memgraph — will attempt all tools');
    }
  }

  // Determine which tools to index
  let tools = allTools;
  if (skipExisting) {
    tools = allTools.filter((id) => {
      const url = toolIdToGithubUrl(id);
      return !indexedUrls.has(url);
    });
  }

  // Apply START_AT offset (resume support)
  if (startAt) {
    const idx = tools.indexOf(startAt);
    if (idx === -1) {
      logger.warn(
        { startAt },
        'START_AT tool not found in remaining list, starting from beginning',
      );
    } else {
      logger.info({ startAt, skipping: idx }, 'Resuming from START_AT');
      tools = tools.slice(idx);
    }
  }

  logger.info({ toIndex: tools.length, skipped: allTools.length - tools.length }, 'Indexing plan');

  if (dryRun) {
    logger.info({ tools }, 'DRY_RUN=1 — would index these tools');
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < tools.length; i++) {
    const toolId = tools[i] as string;
    logger.info({ toolId, progress: `${i + 1}/${tools.length}` }, 'Indexing');

    try {
      await handleIndexJob(toolId, 1);
      succeeded++;
    } catch (err) {
      logger.error({ toolId, err }, 'Tool index failed (continuing)');
      failed++;
    }
  }

  logger.info({ succeeded, failed, total: tools.length }, 'Seed run complete');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Seed run failed');
    process.exit(1);
  })
  .finally(() => {
    closeMemgraphDriver().catch(() => {});
  });
