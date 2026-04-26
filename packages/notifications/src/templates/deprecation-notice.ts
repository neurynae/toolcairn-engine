import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
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
  const _appUrl = escapeHtml(ctx.publicAppUrl);
  const toolUrl = `${ctx.publicAppUrl}/tool/${encodeURIComponent(toolName)}`;
  const alertsUrl = `${ctx.publicAppUrl}/settings`;
  const isCritical = severity === 'critical';
  const accentBg = isCritical ? '#fef2f2' : '#fffbeb';
  const accentBorder = isCritical ? '#fecaca' : '#fde68a';
  const accentText = isCritical ? '#b91c1c' : '#92400e';
  const pillBg = isCritical ? '#ef4444' : '#f59e0b';

  const bodyHtml = `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 14px">
  <tr>
    <td style="background:${pillBg};padding:3px 10px;border-radius:999px;color:#ffffff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(severity)}</td>
  </tr>
</table>
<h1 style="font-size:20px;font-weight:600;line-height:1.3;margin:0 0 14px;color:#111827">${escapeHtml(toolName)} &mdash; deprecation detected</h1>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;background:${accentBg};border:1px solid ${accentBorder};border-radius:8px">
  <tr>
    <td style="padding:16px 20px;font-size:14px;color:${accentText}">
      <p style="margin:0 0 8px"><strong>Signal:</strong> ${escapeHtml(reason.replace(/_/g, ' '))}</p>
      <p style="margin:0">${escapeHtml(details)}</p>
${removesInDays ? `<p style="margin:12px 0 0;font-size:13px"><strong>Scheduled removal from the graph:</strong> ${removesInDays} days.</p>` : ''}
    </td>
  </tr>
</table>

${renderCtaButton(toolUrl, 'See tool details')}
<p style="margin:20px 0 0;font-size:13px;color:#6b7280;text-align:center">You subscribed to deprecation alerts for this tool. Manage subscriptions in <a href="${escapeHtml(alertsUrl)}" style="color:#6b7280;text-decoration:underline">settings</a>.</p>`;

  const preheader = `${toolName} — ${severity} deprecation signal.`;
  return {
    subject: `${isCritical ? '[CRITICAL]' : '[warning]'} ${toolName} deprecation`,
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
