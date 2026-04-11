/**
 * One-time migration: add GitHub topics and UseCase/Pattern/Stack nodes
 * to existing Tool nodes in Memgraph.
 *
 * Usage:
 *   pnpm tsx src/run-migrate-topics.ts
 *
 * Environment variables:
 *   START_AT=tool-name   — resume from a specific tool name (alphabetical order)
 *   DRY_RUN=1            — log what would be done without writing
 *   BATCH_SIZE=10        — number of tools per batch (default: 5, rate-limit friendly)
 */

import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { createLogger } from '@toolcairn/errors';
import { crawlGitHubRepo } from './crawlers/github.js';
import { NOISE_TOPICS, buildTopicEdges } from './processors/index.js';
import { writeTopicNodes } from './writers/memgraph.js';

const logger = createLogger({ name: '@toolcairn/indexer:migrate-topics' });

// ─── Config from env ──────────────────────────────────────────────────────────

const START_AT = process.env.START_AT ?? null;
const DRY_RUN = process.env.DRY_RUN === '1';
const BATCH_SIZE = (() => {
  const v = Number.parseInt(process.env.BATCH_SIZE ?? '', 10);
  return v > 0 ? v : 5;
})();

// Delay between batches to stay well within 5000 req/hr GitHub limit.
// At BATCH_SIZE=5 this gives 12 batches/min = 60 req/min = 3600 req/hr (safe headroom).
const INTER_BATCH_DELAY_MS = 5_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ToolRow {
  name: string;
  github_url: string | null;
  id: string;
}

interface MigrationStats {
  total: number;
  updated: number;
  skipped: number; // already had topics
  failed: number;
  useCaseNodes: number;
  patternNodes: number;
  stackNodes: number;
}

// ─── Memgraph helpers ─────────────────────────────────────────────────────────

async function fetchAllTools(): Promise<ToolRow[]> {
  const session = getMemgraphSession();
  try {
    const result = await session.run(
      'MATCH (t:Tool) RETURN t.name AS name, t.github_url AS github_url, t.id AS id ORDER BY t.name',
    );
    return result.records.map((r) => {
      const obj = r.toObject() as Record<string, unknown>;
      return {
        name: String(obj.name ?? ''),
        github_url: typeof obj.github_url === 'string' ? obj.github_url : null,
        id: String(obj.id ?? ''),
      };
    });
  } finally {
    await session.close();
  }
}

async function setToolTopics(name: string, topics: string[]): Promise<void> {
  const session = getMemgraphSession();
  try {
    await session.run('MATCH (t:Tool {name: $name}) SET t.topics = $topics', { name, topics });
  } finally {
    await session.close();
  }
}

async function countTopicNodes(): Promise<{
  useCases: number;
  patterns: number;
  stacks: number;
  solvesEdges: number;
  followsEdges: number;
  belongsToEdges: number;
}> {
  const session = getMemgraphSession();
  try {
    const result = await session.run(`
      MATCH (u:UseCase) WITH count(u) AS useCases
      MATCH (p:Pattern) WITH useCases, count(p) AS patterns
      MATCH (s:Stack) WITH useCases, patterns, count(s) AS stacks
      OPTIONAL MATCH ()-[r1:SOLVES]->() WITH useCases, patterns, stacks, count(r1) AS solvesEdges
      OPTIONAL MATCH ()-[r2:FOLLOWS]->() WITH useCases, patterns, stacks, solvesEdges, count(r2) AS followsEdges
      OPTIONAL MATCH ()-[r3:BELONGS_TO]->() RETURN useCases, patterns, stacks, solvesEdges, followsEdges, count(r3) AS belongsToEdges
    `);
    const row = result.records[0]?.toObject() as Record<string, unknown> | undefined;
    const toNum = (v: unknown): number => {
      if (typeof v === 'number') return v;
      if (
        v != null &&
        typeof v === 'object' &&
        'toNumber' in v &&
        typeof (v as { toNumber: () => number }).toNumber === 'function'
      )
        return (v as { toNumber: () => number }).toNumber();
      return Number(v ?? 0);
    };
    return {
      useCases: toNum(row?.useCases),
      patterns: toNum(row?.patterns),
      stacks: toNum(row?.stacks),
      solvesEdges: toNum(row?.solvesEdges),
      followsEdges: toNum(row?.followsEdges),
      belongsToEdges: toNum(row?.belongsToEdges),
    };
  } finally {
    await session.close();
  }
}

// ─── GitHub URL parser ────────────────────────────────────────────────────────

/**
 * Extract owner/repo from a GitHub URL or an already-formatted "owner/repo" string.
 * Returns null if the URL cannot be parsed.
 */
function parseGitHubUrl(githubUrl: string): { owner: string; repo: string } | null {
  try {
    // Handle "owner/repo" shorthand (no scheme)
    if (!githubUrl.includes('://')) {
      const parts = githubUrl.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const owner = parts[parts.length - 2];
        const repo = parts[parts.length - 1];
        if (owner && repo) return { owner, repo: repo.replace(/\.git$/, '') };
      }
      return null;
    }

    const url = new URL(githubUrl);
    if (!url.hostname.includes('github.com')) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;

    const owner = segments[0];
    const repo = segments[1];
    if (!owner || !repo) return null;

    return { owner, repo: repo.replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

// ─── Batch sleep utility ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─── Per-tool migration ───────────────────────────────────────────────────────

async function migrateTool(tool: ToolRow, stats: MigrationStats): Promise<void> {
  if (!tool.github_url) {
    logger.warn({ toolName: tool.name }, 'No github_url — skipping');
    stats.failed++;
    return;
  }

  const parsed = parseGitHubUrl(tool.github_url);
  if (!parsed) {
    logger.warn(
      { toolName: tool.name, github_url: tool.github_url },
      'Could not parse github_url — skipping',
    );
    stats.failed++;
    return;
  }

  try {
    logger.info(
      { toolName: tool.name, owner: parsed.owner, repo: parsed.repo },
      'Fetching topics from GitHub',
    );

    const crawlResult = await crawlGitHubRepo(parsed.owner, parsed.repo);
    const rawData = crawlResult.raw as Record<string, unknown>;
    const allTopics = Array.isArray(rawData.topics) ? (rawData.topics as string[]) : [];
    const meaningfulTopics = allTopics.filter((t) => !NOISE_TOPICS.has(t));

    if (meaningfulTopics.length === 0) {
      logger.info(
        { toolName: tool.name, allTopics },
        'No meaningful topics after filtering — skipping write',
      );
      stats.skipped++;
      return;
    }

    const topicEdges = buildTopicEdges(meaningfulTopics);

    logger.info(
      {
        toolName: tool.name,
        topicsCount: meaningfulTopics.length,
        edgesCount: topicEdges.length,
        topics: meaningfulTopics,
      },
      DRY_RUN ? 'DRY RUN — would update topics' : 'Updating topics in Memgraph',
    );

    if (!DRY_RUN) {
      // 1. Set t.topics on the Tool node
      await setToolTopics(tool.name, meaningfulTopics);

      // 2. Create/merge UseCase, Pattern, Stack nodes and their typed edges
      await writeTopicNodes(tool.id, topicEdges);
    }

    // Tally node types created
    for (const edge of topicEdges) {
      if (edge.nodeType === 'UseCase') stats.useCaseNodes++;
      else if (edge.nodeType === 'Pattern') stats.patternNodes++;
      else stats.stackNodes++;
    }

    stats.updated++;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error({ toolName: tool.name, err: message }, 'Failed to migrate tool — continuing');
    stats.failed++;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ START_AT, DRY_RUN, BATCH_SIZE }, 'Starting topic migration');

  // 1. Fetch all tools from Memgraph
  let tools: ToolRow[];
  try {
    tools = await fetchAllTools();
  } catch (e) {
    logger.error({ err: e }, 'Failed to fetch tools from Memgraph — aborting');
    process.exit(1);
  }

  logger.info({ totalTools: tools.length }, 'Fetched tools from Memgraph');

  // 2. Apply START_AT resume filter
  let workList = tools;
  if (START_AT) {
    const startIdx = tools.findIndex((t) => t.name >= START_AT);
    if (startIdx === -1) {
      logger.warn({ START_AT }, 'START_AT tool not found in list — running full migration');
    } else {
      workList = tools.slice(startIdx);
      logger.info(
        { START_AT, resumeFrom: workList[0]?.name, remaining: workList.length },
        'Resuming from START_AT',
      );
    }
  }

  const stats: MigrationStats = {
    total: workList.length,
    updated: 0,
    skipped: 0,
    failed: 0,
    useCaseNodes: 0,
    patternNodes: 0,
    stackNodes: 0,
  };

  // 3. Process in batches
  for (let batchStart = 0; batchStart < workList.length; batchStart += BATCH_SIZE) {
    const batch = workList.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(workList.length / BATCH_SIZE);

    logger.info(
      {
        batchNum,
        totalBatches,
        batchSize: batch.length,
        progress: `${batchStart + batch.length}/${workList.length}`,
      },
      'Processing batch',
    );

    // Tools in a batch are processed sequentially to respect GitHub session rules
    // and avoid secondary rate limit triggers from concurrent requests.
    for (const tool of batch) {
      await migrateTool(tool, stats);
    }

    // Delay between batches (skip after the final batch)
    const isLastBatch = batchStart + BATCH_SIZE >= workList.length;
    if (!isLastBatch) {
      logger.debug({ delayMs: INTER_BATCH_DELAY_MS }, 'Sleeping between batches');
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  // 4. Post-migration verification query
  logger.info('Running post-migration verification counts...');
  let verificationCounts: Awaited<ReturnType<typeof countTopicNodes>> | null = null;
  try {
    if (!DRY_RUN) {
      verificationCounts = await countTopicNodes();
    }
  } catch (e) {
    logger.warn({ err: e }, 'Verification query failed (non-fatal)');
  }

  // 5. Print summary
  logger.info(
    {
      summary: {
        total: stats.total,
        updated: stats.updated,
        skipped: stats.skipped,
        failed: stats.failed,
        topicNodesCreated: {
          useCase: stats.useCaseNodes,
          pattern: stats.patternNodes,
          stack: stats.stackNodes,
          total: stats.useCaseNodes + stats.patternNodes + stats.stackNodes,
        },
      },
    },
    '=== Migration complete ===',
  );

  if (verificationCounts) {
    logger.info(
      {
        memgraphState: {
          useCaseNodes: verificationCounts.useCases,
          patternNodes: verificationCounts.patterns,
          stackNodes: verificationCounts.stacks,
          solvesEdges: verificationCounts.solvesEdges,
          followsEdges: verificationCounts.followsEdges,
          belongsToEdges: verificationCounts.belongsToEdges,
        },
      },
      '=== Verification counts (live Memgraph) ===',
    );
  }

  if (stats.failed > 0) {
    logger.warn(
      { failedCount: stats.failed },
      'Some tools failed — re-run with START_AT to retry specific tools',
    );
  }

  // 6. Close Memgraph driver cleanly
  await closeMemgraphDriver();

  process.exit(stats.failed > 0 ? 1 : 0);
}

main();
