/**
 * Crawls GitHub Issues for all tools in Memgraph and upserts them into the
 * Qdrant 'issues' collection for semantic search by check_issue.
 *
 * Run with:
 *   cd apps/indexer && pnpm exec tsx src/run-index-issues.ts
 *
 * Env:
 *   GITHUB_TOKEN      Strongly recommended (5000 req/hr vs 60 unauth)
 *   NOMIC_API_KEY     Optional — falls back to zero-vector (BM25-only) if absent
 *   DRY_RUN=1         Print tool list without fetching or writing
 *   TOOL_NAME=prisma  Run for a single tool only (useful for debugging)
 */
import { getMemgraphSession } from '@toolcairn/graph';
import { ensureIssuesCollection } from '@toolcairn/vector';
import { createLogger } from '@toolcairn/errors';
import { fetchToolIssues } from './crawlers/github-issues.js';
import { upsertIssueVectors } from './writers/qdrant-issues.js';

const logger = createLogger({ name: '@toolcairn/indexer:index-issues' });

interface ToolRow {
  name: string;
  github_url: string;
}

async function loadToolsFromMemgraph(): Promise<ToolRow[]> {
  const session = getMemgraphSession();
  try {
    const result = await session.run(
      'MATCH (t:Tool) WHERE t.github_url IS NOT NULL RETURN t.name AS name, t.github_url AS github_url ORDER BY t.name',
    );
    return result.records.map((r) => ({
      name: String(r.get('name')),
      github_url: String(r.get('github_url')),
    }));
  } finally {
    await session.close();
  }
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/|$)/);
  return m ? { owner: m[1] ?? '', repo: m[2] ?? '' } : null;
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1';
  const singleTool = process.env.TOOL_NAME;

  logger.info('Loading tools from Memgraph…');
  let tools = await loadToolsFromMemgraph();
  logger.info({ total: tools.length }, 'Tools with GitHub URL loaded');

  // Filter to single tool if requested
  if (singleTool) {
    tools = tools.filter((t) => t.name === singleTool);
    if (tools.length === 0) {
      logger.error({ tool: singleTool }, 'Tool not found in Memgraph');
      process.exit(1);
    }
  }

  // Parse owner/repo from GitHub URLs
  const parsedTools = tools
    .map((t) => ({ ...t, parsed: parseGitHubUrl(t.github_url) }))
    .filter((t): t is typeof t & { parsed: NonNullable<typeof t.parsed> } => t.parsed !== null);

  const skipped = tools.length - parsedTools.length;
  if (skipped > 0) {
    logger.warn({ skipped }, 'Tools with unparseable GitHub URLs skipped');
  }

  if (dryRun) {
    logger.info({ count: parsedTools.length }, 'DRY_RUN — tools that would be crawled:');
    for (const t of parsedTools) {
      logger.info({ name: t.name, owner: t.parsed.owner, repo: t.parsed.repo }, 'Tool');
    }
    process.exit(0);
  }

  await ensureIssuesCollection();
  logger.info('Issues collection ready');

  let succeeded = 0;
  let failed = 0;
  let totalIssues = 0;

  for (const tool of parsedTools) {
    try {
      const issues = await fetchToolIssues({
        toolName: tool.name,
        owner: tool.parsed.owner,
        repo: tool.parsed.repo,
      });

      await upsertIssueVectors(issues);
      succeeded++;
      totalIssues += issues.length;

      logger.info(
        {
          tool: tool.name,
          issues: issues.length,
          open: issues.filter((i) => i.state === 'open').length,
          closed: issues.filter((i) => i.state === 'closed').length,
        },
        'Tool issues indexed',
      );
    } catch (err) {
      failed++;
      logger.error({ err, tool: tool.name }, 'Failed to index issues for tool');
    }
  }

  logger.info({ succeeded, failed, totalIssues }, 'Issue indexing complete');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Issue indexer failed');
  process.exit(1);
});
