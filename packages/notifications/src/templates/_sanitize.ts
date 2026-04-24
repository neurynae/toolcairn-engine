// Template sanitization helpers. Every dynamic field interpolated into an email
// HTML body MUST pass through escapeHtml(), since user-provided names / tool
// names / etc. can break the layout or inject markup in HTML-rendering clients.
//
// URLs interpolated into `<a href>` are additionally validated so we don't
// generate mailto-chain or javascript: links from untrusted input.

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
};

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'/]/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function safeUrl(raw: string | null | undefined, fallback = '#'): string {
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:' &&
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'mailto:'
    )
      return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

/**
 * Plain-text fallback generator — strips HTML tags crudely so templates can
 * derive a text/plain variant from the rendered HTML for Resend's text field
 * (recommended for spam scoring and accessibility).
 */
export function toPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
