import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface DeprecationNoticePayload {
  toolName: string;
  reason: string; // npm_deprecated | repo_archived | stale_commits | open_issues
  severity: 'warning' | 'critical';
  details: string;
  removesInDays?: number;
}

export function renderDeprecationNotice(
  ctx: EmailContext<DeprecationNoticePayload>,
): RenderedEmail {
  const { toolName, reason, severity, details, removesInDays } = ctx.payload;
  const appUrl = escapeHtml(ctx.publicAppUrl);
  const color = severity === 'critical' ? '#ef4444' : '#f59e0b';

  const removalBlock = removesInDays
    ? `<p style="margin:16px 0 0"><strong>Scheduled removal from the graph:</strong> ${removesInDays} days.</p>`
    : '';

  const bodyHtml = `
<div style="display:inline-block;padding:4px 10px;background:${color};color:#ffffff;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px">${escapeHtml(severity)}</div>
<h1 style="font-size:20px;font-weight:600;margin:0 0 12px">${escapeHtml(toolName)} — deprecation detected</h1>
<p><strong>Signal:</strong> ${escapeHtml(reason.replace(/_/g, ' '))}</p>
<p>${escapeHtml(details)}</p>
${removalBlock}
<p style="text-align:center;margin:28px 0">
  <a href="${appUrl}/tool/${encodeURIComponent(toolName)}" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">See tool details</a>
</p>
<p style="color:#6b7280;font-size:13px">You subscribed to deprecation alerts for this tool. Unsubscribe per-tool in <a href="${appUrl}/settings/alerts" style="color:#6b7280">your alert preferences</a>.</p>`;

  const html = renderLayout({
    preheader: `${toolName} — ${severity} deprecation signal.`,
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return {
    subject: `${severity === 'critical' ? '[CRITICAL]' : '[warning]'} ${toolName} deprecation`,
    html,
    text: toPlainText(bodyHtml),
    preheader: `${toolName} — ${severity} deprecation signal.`,
  };
}
