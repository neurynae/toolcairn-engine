import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, safeUrl, toPlainText } from './_sanitize.js';

export interface McpReleasePayload {
  version: string;
  prevVersion: string;
  kind: 'minor' | 'major';
  releaseNotesUrl: string;
  /** Parsed from release notes — optional. */
  deprecations?: Array<{ feature: string; removesInVersion?: string; migrateTo?: string }>;
}

export function renderMcpRelease(ctx: EmailContext<McpReleasePayload>): RenderedEmail {
  const { version, prevVersion, kind, releaseNotesUrl, deprecations } = ctx.payload;
  const notesHref = escapeHtml(safeUrl(releaseNotesUrl));

  const deprecationsBlock =
    deprecations && deprecations.length > 0
      ? `
<h2 style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#ef4444;margin:24px 0 8px">Deprecations</h2>
<ul style="margin:0 0 16px;padding-left:20px">
${deprecations
  .map(
    (d) =>
      `<li><strong>${escapeHtml(d.feature)}</strong>${d.removesInVersion ? ` — scheduled removal in v${escapeHtml(d.removesInVersion)}` : ''}${d.migrateTo ? `. Migrate to <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px">${escapeHtml(d.migrateTo)}</code>` : ''}</li>`,
  )
  .join('\n')}
</ul>`
      : '';

  const bodyHtml = `
<h1 style="font-size:20px;font-weight:600;margin:0 0 16px">@neurynae/toolcairn-mcp v${escapeHtml(version)} — ${kind} release</h1>
<p>Released from v${escapeHtml(prevVersion)}. Update when it fits your workflow:</p>
<pre style="background:#f3f4f6;padding:12px 16px;border-radius:6px;font-family:'SF Mono',Consolas,monospace;font-size:13px;overflow-x:auto;margin:16px 0">npm i -g @neurynae/toolcairn-mcp@${escapeHtml(version)}</pre>
${deprecationsBlock}
<p style="text-align:center;margin:28px 0">
  <a href="${notesHref}" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">Read the release notes</a>
</p>
<p style="color:#6b7280;font-size:13px">You can unsubscribe from release announcements in your <a href="${escapeHtml(ctx.publicAppUrl)}/settings" style="color:#6b7280">notification settings</a>.</p>`;

  const html = renderLayout({
    preheader: `v${version} — ${kind} release${deprecations && deprecations.length ? ' with deprecations' : ''}.`,
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return {
    subject: `@neurynae/toolcairn-mcp v${version} released`,
    html,
    text: toPlainText(bodyHtml),
    preheader: `v${version} — ${kind} release.`,
  };
}
