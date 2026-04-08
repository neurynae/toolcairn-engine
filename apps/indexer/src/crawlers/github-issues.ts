import { createHash } from 'node:crypto';
import pino from 'pino';
import { getOctokit, githubRequest } from './github.js';

const logger = pino({ name: '@toolcairn/indexer:github-issues-crawler' });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitHubIssue {
  id: string; // deterministic UUID from SHA-256(repoUrl/issues/number)
  tool_name: string;
  issue_number: number;
  title: string;
  body: string; // truncated to 2000 chars
  state: 'open' | 'closed';
  labels: string[];
  github_url: string; // html_url of the issue
  repo_url: string; // https://github.com/owner/repo
  created_at: string;
  updated_at: string;
}

export interface FetchIssuesOptions {
  toolName: string;
  owner: string;
  repo: string;
  openLimit?: number; // default 100
  closedSinceDays?: number; // default 90
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface GitHubIssueRaw {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  pull_request?: unknown;
  labels: Array<{ name?: string }>;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip lone Unicode surrogates that Qdrant's Rust JSON parser rejects.
 * TextEncoder converts to valid UTF-8 bytes (replacing surrogates with U+FFFD),
 * then TextDecoder converts back to a clean string.
 */
function sanitizeString(text: string): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return decoder.decode(encoder.encode(text));
}

/**
 * Deterministic UUID v4-format ID from SHA-256 of the issue's canonical URL.
 * Mirrors the deterministicId() pattern used for tool IDs.
 */
function issueId(repoUrl: string, issueNumber: number): string {
  const hash = createHash('sha256').update(`${repoUrl}/issues/${issueNumber}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function toGitHubIssue(raw: GitHubIssueRaw, toolName: string, repoUrl: string): GitHubIssue {
  return {
    id: issueId(repoUrl, raw.number),
    tool_name: toolName,
    issue_number: raw.number,
    title: sanitizeString(raw.title),
    body: sanitizeString((raw.body ?? '').slice(0, 2000)),
    state: raw.state === 'open' ? 'open' : 'closed',
    labels: raw.labels.map((l) => l.name ?? '').filter(Boolean),
    github_url: raw.html_url,
    repo_url: repoUrl,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch open issues and recently-closed issues for a GitHub repository.
 * Filters out pull requests (pull_request field present).
 */
export async function fetchToolIssues(options: FetchIssuesOptions): Promise<GitHubIssue[]> {
  const { toolName, owner, repo, openLimit = 100, closedSinceDays = 90 } = options;
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const octokit = getOctokit();

  logger.debug({ toolName, owner, repo }, 'Fetching issues');

  // Open issues — one page up to openLimit
  const rawOpen = await githubRequest<GitHubIssueRaw[]>(
    `issues-open:${owner}/${repo}`,
    (headers) =>
      octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        per_page: Math.min(openLimit, 100),
        page: 1,
        headers: headers as Record<string, string>,
      }) as Promise<{ data: unknown; headers: Record<string, string | undefined> }>,
  );

  // Recently-closed issues — last closedSinceDays days
  const since = new Date(Date.now() - closedSinceDays * 86_400_000).toISOString();
  const rawClosed = await githubRequest<GitHubIssueRaw[]>(
    `issues-closed:${owner}/${repo}`,
    (headers) =>
      octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'closed',
        since,
        per_page: 50,
        page: 1,
        headers: headers as Record<string, string>,
      }) as Promise<{ data: unknown; headers: Record<string, string | undefined> }>,
  );

  const allRaw = [
    ...(Array.isArray(rawOpen) ? rawOpen : []),
    ...(Array.isArray(rawClosed) ? rawClosed : []),
  ];

  const issues = allRaw
    .filter((r) => r.pull_request === undefined) // exclude PRs
    .map((r) => toGitHubIssue(r, toolName, repoUrl));

  logger.debug(
    { toolName, open: rawOpen?.length ?? 0, closed: rawClosed?.length ?? 0, issues: issues.length },
    'Issues fetched',
  );

  return issues;
}
