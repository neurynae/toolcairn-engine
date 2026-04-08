import { config } from '@toolcairn/config';
import pino from 'pino';
import type { ToolDeps } from '../types.js';
import { errResult, okResult } from '../utils.js';

const logger = pino({ name: '@toolcairn/tools:check-issue' });

const DOCS_RETRY_THRESHOLD = 4;

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  pull_request?: { merged_at: string | null; html_url: string };
  labels: Array<{ name: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  reactions?: { '+1': number; total_count: number };
}

interface GitHubSearchResult {
  total_count: number;
  items: GitHubIssue[];
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  }
  return headers;
}

async function searchGitHubIssues(
  owner: string,
  repoName: string,
  query: string,
  type: 'issue' | 'pr',
): Promise<GitHubIssue[]> {
  const q = encodeURIComponent(`${query} repo:${owner}/${repoName} type:${type}`);
  const url = `https://api.github.com/search/issues?q=${q}&sort=relevance&per_page=5`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    if (res.status === 422 || res.status === 403) return [];
    throw new Error(`GitHub Search API error: ${res.status}`);
  }
  const data = (await res.json()) as GitHubSearchResult;
  return data.items ?? [];
}

async function addReaction(owner: string, repoName: string, issueNumber: number): Promise<boolean> {
  if (!config.GITHUB_TOKEN) return false;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/reactions`,
      {
        method: 'POST',
        headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '+1' }),
      },
    );
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

function buildIssueGist(issue: GitHubIssue): string {
  const labels = issue.labels.map((l) => l.name).join(', ');
  const bodySnippet = (issue.body ?? '').slice(0, 500).replace(/\r?\n/g, ' ');
  return [
    `Title: ${issue.title}`,
    labels ? `Labels: ${labels}` : null,
    bodySnippet
      ? `Description: ${bodySnippet}${issue.body && issue.body.length > 500 ? '...' : ''}`
      : null,
    `State: ${issue.state}`,
    `Comments: ${issue.comments}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function parseGitHubRepo(githubUrl: string): { owner: string; repo: string } | null {
  const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) return null;
  return { owner: match[1] ?? '', repo: (match[2] ?? '').replace(/\.git$/, '') };
}

export function createCheckIssueHandler(deps: Pick<ToolDeps, 'graphRepo'>) {
  return async function handleCheckIssue(args: {
    tool_name: string;
    issue_title: string;
    retry_count?: number;
    docs_consulted?: boolean;
    issue_url?: string;
  }) {
    try {
      const retryCount = args.retry_count ?? 0;
      const docsConsulted = args.docs_consulted ?? false;

      logger.info(
        { tool_name: args.tool_name, issue_title: args.issue_title, retryCount, docsConsulted },
        'check_issue called',
      );

      if (retryCount < DOCS_RETRY_THRESHOLD || !docsConsulted) {
        const nextStep = !docsConsulted
          ? "Consult the documentation link in the tool's prompt_hint before calling check_issue."
          : `Retry at least ${DOCS_RETRY_THRESHOLD} times total before checking GitHub issues. You have tried ${retryCount} time(s).`;
        return okResult({
          status: 'too_early',
          message: 'check_issue is a last resort. Exhaust documentation and retries first.',
          retry_count: retryCount,
          docs_consulted: docsConsulted,
          next_step: nextStep,
          agent_instructions: [
            '1. Try to fix the error yourself (up to 2 retries).',
            "2. Read the tool's documentation — use the docs_url/readme_url from search_tools results.",
            '3. Apply documentation guidance and retry (up to 2 more retries).',
            '4. Only call check_issue after 4+ total retries AND docs_consulted=true.',
          ].join(' '),
        });
      }

      const toolResult = await deps.graphRepo.findByName(args.tool_name);
      if (!toolResult.ok) {
        return errResult('db_error', toolResult.error.message);
      }
      if (!toolResult.data) {
        return errResult(
          'tool_not_found',
          `Tool '${args.tool_name}' is not in the ToolPilot index. Try search_tools to find the correct tool name.`,
        );
      }
      const tool = toolResult.data;

      const parsed = parseGitHubRepo(tool.github_url);
      if (!parsed) {
        return errResult('parse_error', `Cannot parse GitHub repo from: ${tool.github_url}`);
      }
      const { owner, repo: repoName } = parsed;

      logger.info({ owner, repo: repoName, query: args.issue_title }, 'Searching GitHub issues');
      const [issues, prs] = await Promise.all([
        searchGitHubIssues(owner, repoName, args.issue_title, 'issue'),
        searchGitHubIssues(owner, repoName, args.issue_title, 'pr'),
      ]);

      if (issues.length === 0 && prs.length === 0) {
        return okResult({
          status: 'not_found',
          tool: args.tool_name,
          message: `No matching issue found on GitHub for '${args.tool_name}'.`,
          github_issues_url: `${tool.github_url}/issues`,
          agent_instructions: [
            'No known GitHub issue matches this error.',
            'Investigate: (1) environment/config differences, (2) version mismatch, (3) incorrect usage.',
            'Re-read the documentation section relevant to this error.',
          ].join(' '),
        });
      }

      const openIssues = issues.filter((i) => i.state === 'open');
      const closedIssues = issues.filter((i) => i.state === 'closed');
      const topIssue = openIssues[0] ?? closedIssues[0];
      const openPrs = prs.filter((pr) => pr.state === 'open');
      const mergedPrs = prs.filter((pr) => pr.pull_request?.merged_at != null);
      const topPr = openPrs[0] ?? mergedPrs[0];

      if (!topIssue || topIssue.state === 'closed') {
        const fixInfo = mergedPrs[0]
          ? `PR #${mergedPrs[0].number} was merged: ${mergedPrs[0].html_url}`
          : `Issue was closed: ${topIssue?.html_url ?? `${tool.github_url}/issues`}`;
        return okResult({
          status: 'fixed_in_version',
          tool: args.tool_name,
          issue: topIssue
            ? {
                number: topIssue.number,
                title: topIssue.title,
                github_url: topIssue.html_url,
                closed_at: topIssue.closed_at,
              }
            : null,
          fix_info: fixInfo,
          message: `This issue appears to have been fixed. ${fixInfo}`,
          agent_instructions: 'Update the tool to the latest version to get this fix.',
        });
      }

      const reactionAdded = await addReaction(owner, repoName, topIssue.number);

      if (topPr && topPr.state === 'open') {
        return okResult({
          status: 'fix_in_progress',
          tool: args.tool_name,
          issue: {
            number: topIssue.number,
            title: topIssue.title,
            github_url: topIssue.html_url,
            gist: buildIssueGist(topIssue),
          },
          pr: {
            number: topPr.number,
            title: topPr.title,
            github_url: topPr.html_url,
            state: 'open',
          },
          reaction_added: reactionAdded,
          message: `Known issue — a fix is in progress (PR #${topPr.number}).`,
          agent_instructions:
            'A fix is in progress. Consider checking if a pre-release has the fix, or applying a temporary workaround.',
        });
      }

      return okResult({
        status: 'known_issue_no_fix',
        tool: args.tool_name,
        issue: {
          number: topIssue.number,
          title: topIssue.title,
          github_url: topIssue.html_url,
          state: topIssue.state,
          comments: topIssue.comments,
          created_at: topIssue.created_at,
          gist: buildIssueGist(topIssue),
        },
        reaction_added: reactionAdded,
        other_matching_issues: openIssues.slice(1, 3).map((i) => ({
          number: i.number,
          title: i.title,
          github_url: i.html_url,
        })),
        message: `Known open issue (#${topIssue.number}): "${topIssue.title}".`,
        user_action_required: {
          question:
            'What would you like to do? Options: (a) Create a new issue, (b) Handle later, (c) Ignore.',
          github_new_issue_url: `${tool.github_url}/issues/new`,
        },
        agent_instructions: `Issue #${topIssue.number} is open with no fix. Ask user whether to create a new issue, handle later, or ignore.`,
      });
    } catch (e) {
      logger.error({ err: e, tool_name: args.tool_name }, 'check_issue failed');
      return errResult('internal_error', e instanceof Error ? e.message : String(e));
    }
  };
}
