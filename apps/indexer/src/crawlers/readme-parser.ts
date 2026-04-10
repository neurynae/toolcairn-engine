/**
 * Extract documentation URLs from README markdown content.
 *
 * Priority order:
 *  1. Markdown links with explicit docs-related anchor text
 *  2. URLs pointing to known doc hosting platforms
 *  3. URLs with /docs/, /api/, /guide/ in the path
 *
 * Excluded: github.com links, npmjs.com links, badge CDN links, CI/CD badges.
 */

/** Normalize a found URL — strip trailing punctuation / angle brackets. */
function clean(url: string): string {
  return url.replace(/[)>\s,;]+$/, '').trim();
}

function isExcluded(url: string): boolean {
  return (
    url.includes('github.com') ||
    url.includes('npmjs.com') ||
    url.includes('shields.io') ||
    url.includes('badge') ||
    url.includes('travis-ci') ||
    url.includes('circleci') ||
    url.includes('codecov') ||
    url.includes('coveralls') ||
    url.includes('snyk.io') ||
    url.includes('gitter.im') ||
    url.includes('discord') ||
    url.includes('slack') ||
    url.includes('twitter')
  );
}

/**
 * Extract markdown links: [anchor text](url)
 * Returns { text, url } pairs.
 */
function extractMarkdownLinks(md: string): Array<{ text: string; url: string }> {
  const results: Array<{ text: string; url: string }> = [];
  // Match [text](url) — handles nested brackets in text, but not nested parens
  const re = /\[([^\]]{1,120})\]\((https?:\/\/[^)\s]{5,300})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const text = (m[1] ?? '').toLowerCase().trim();
    const url = clean(m[2] ?? '');
    if (!isExcluded(url)) {
      results.push({ text, url });
    }
  }
  return results;
}

const DOCS_ANCHOR_RE =
  /\b(?:documentation|api\s+reference|api\s+docs?|full\s+docs?|user\s+guide|getting\s+started|official\s+docs?|reference\s+docs?|developer\s+docs?)\b/i;

const LOOSE_DOCS_ANCHOR_RE = /\bdocs?\b/i;

const KNOWN_DOC_HOSTS = [
  'readthedocs.io',
  'readthedocs.org',
  'gitbook.io',
  'docs.rs',
  'pkg.go.dev',
  'typedoc',
  'jsdoc',
  'mkdocs',
  'docusaurus',
  '.github.io',
];

const DOC_PATH_RE = /\/(?:docs?|documentation|api|guide|reference|manual)(?:\/|$)/i;

/**
 * Given README markdown, return the best candidate documentation URL,
 * or undefined if none is found.
 */
export function extractDocsUrl(readme: string): string | undefined {
  if (!readme) return undefined;

  const links = extractMarkdownLinks(readme);

  // Priority 1 — explicit docs-labeled anchor text
  for (const { text, url } of links) {
    if (DOCS_ANCHOR_RE.test(text)) return url;
  }

  // Priority 2 — known doc hosting platforms (from any link)
  for (const { url } of links) {
    if (KNOWN_DOC_HOSTS.some((h) => url.includes(h))) return url;
  }

  // Also scan raw text for bare readthedocs / gitbook URLs
  const rtdMatch = readme.match(/https?:\/\/[a-z0-9-]+\.readthedocs\.[a-z]+[^\s)"'<>]*/i);
  if (rtdMatch) {
    const url = clean(rtdMatch[0]);
    if (!isExcluded(url)) return url;
  }

  // Priority 3 — loose "docs" anchor text
  for (const { text, url } of links) {
    if (LOOSE_DOCS_ANCHOR_RE.test(text)) return url;
  }

  // Priority 4 — docs/api path in the URL
  for (const { url } of links) {
    if (DOC_PATH_RE.test(url)) return url;
  }

  return undefined;
}
