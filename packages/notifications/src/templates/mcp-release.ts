import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, safeUrl, toPlainText } from './_sanitize.js';

export interface McpReleasePayload {
  version: string;
  prevVersion: string;
  kind: 'minor' | 'major';
  releaseNotesUrl: string;
  deprecations?: Array<{ feature: string; removesInVersion?: string; migrateTo?: string }>;
}

export function renderMcpRelease(ctx: EmailContext<McpReleasePayload>): RenderedEmail {
  const { version, prevVersion, kind, releaseNotesUrl, deprecations } = ctx.payload;
  const notesHref = safeUrl(releaseNotesUrl);
  const settingsUrl = `${ctx.publicAppUrl}/settings`;

  const deprecationsBlock =
    deprecations && deprecations.length > 0
      ? `
<p style="margin:22px 0 10px;font-size:12px;font-weight:600;color:#ef4444;text-transform:uppercase;letter-spacing:0.05em">Deprecations in this release</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">
  <tr>
    <td style="padding:16px 20px;font-size:14px;color:#7f1d1d">
      ${deprecations
        .map(
          (d) =>
            `<p style="margin:0 0 8px">&bull; <strong>${escapeHtml(d.feature)}</strong>${d.removesInVersion ? ` &mdash; scheduled removal in v${escapeHtml(d.removesInVersion)}` : ''}${d.migrateTo ? `. Migrate to <code style="background:#fff;padding:1px 6px;border-radius:4px;font-family:SFMono-Regular,Consolas,monospace;font-size:12.5px">${escapeHtml(d.migrateTo)}</code>` : ''}</p>`,
        )
        .join('')}
    </td>
  </tr>
</table>`
      : '';

  const bodyHtml = `
<h1 style="font-size:20px;font-weight:600;line-height:1.3;margin:0 0 10px;color:#111827">@neurynae/toolcairn-mcp v${escapeHtml(version)}</h1>
<p style="margin:0 0 18px;font-size:13px;color:#6b7280">${kind === 'major' ? 'Major' : 'Minor'} release &mdash; updated from v${escapeHtml(prevVersion)}</p>
<p style="margin:0 0 10px;font-size:14px">Update when it fits your workflow:</p>
<pre style="margin:0 0 18px;padding:14px 16px;background:#0f172a;color:#e2e8f0;border-radius:8px;font-family:SFMono-Regular,Consolas,monospace;font-size:13px;overflow-x:auto;line-height:1.5">npm i -g @neurynae/toolcairn-mcp@${escapeHtml(version)}</pre>
${deprecationsBlock}
${renderCtaButton(notesHref, 'Read the release notes')}
<p style="margin:20px 0 0;font-size:13px;color:#6b7280;text-align:center">You can unsubscribe from release announcements in your <a href="${escapeHtml(settingsUrl)}" style="color:#6b7280;text-decoration:underline">notification settings</a>.</p>`;

  const preheader = `v${version} — ${kind} release${deprecations?.length ? ' with deprecations' : ''}.`;
  return {
    subject: `@neurynae/toolcairn-mcp v${version} released`,
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
