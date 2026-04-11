/**
 * One-time backfill: populate docs_changelog_url and docs_docs_url for tools
 * already in prod Memgraph that were indexed before docs link extraction was added.
 *
 * Two queries:
 *  A) Set changelog_url = github_url + '/releases' for all GitHub-hosted tools
 *  B) Promote homepage_url → docs_url when homepage is not a GitHub URL
 *
 * Usage: pnpm tsx src/backfill-docs-links.ts
 */

import { closeMemgraphDriver, getMemgraphSession } from '@toolcairn/graph';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/indexer:backfill-docs-links' });

async function main() {
  const session = getMemgraphSession();

  try {
    // A: changelog_url — all GitHub-hosted tools without one
    const changelogResult = await session.run(
      `MATCH (t:Tool)
       WHERE t.github_url CONTAINS 'github.com'
         AND t.docs_changelog_url IS NULL
       SET t.docs_changelog_url = t.github_url + '/releases'
       RETURN count(t) AS updated`,
    );
    const changelogUpdated = changelogResult.records[0]?.get('updated') ?? 0;
    logger.info({ count: changelogUpdated }, 'Set changelog_url from github_url + /releases');

    // B: docs_url — tools where homepage_url is non-GitHub (likely an official docs site)
    const docsResult = await session.run(
      `MATCH (t:Tool)
       WHERE t.homepage_url IS NOT NULL
         AND NOT t.homepage_url CONTAINS 'github.com'
         AND t.docs_docs_url IS NULL
       SET t.docs_docs_url = t.homepage_url
       RETURN count(t) AS updated`,
    );
    const docsUpdated = docsResult.records[0]?.get('updated') ?? 0;
    logger.info({ count: docsUpdated }, 'Set docs_url from homepage_url');

    logger.info({ changelogUpdated, docsUpdated }, 'Backfill complete');
  } finally {
    await session.close();
    await closeMemgraphDriver();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
