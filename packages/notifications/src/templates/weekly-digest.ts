import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface WeeklyDigestPayload {
  userName: string | null;
  weekStart: string;
  toolsUsed: Array<{ tool_name: string; count: number }>;
  deprecationAlerts: Array<{ tool_name: string; severity: string; details: string }>;
  trendingTools: Array<{ tool_name: string; quality_score: number | null }>;
}

function sectionLabel(label: string): string {
  return `<p style="margin:24px 0 10px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(label)}</p>`;
}

function toolRow(appUrl: string, name: string, meta?: string): string {
  return `<tr>
    <td style="padding:10px 0;border-bottom:1px solid #f0f0f0">
      <a href="${appUrl}/tool/${encodeURIComponent(name)}" style="color:#6366f1;text-decoration:none;font-weight:500;font-size:14px">${escapeHtml(name)}</a>
      ${meta ? `<span style="margin-left:8px;font-size:12px;color:#9ca3af">${escapeHtml(meta)}</span>` : ''}
    </td>
  </tr>`;
}

function toolsTable(appUrl: string, rows: string[]): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${rows.join('')}</table>`;
}

export function renderWeeklyDigest(ctx: EmailContext<WeeklyDigestPayload>): RenderedEmail {
  const { userName, weekStart, toolsUsed, deprecationAlerts, trendingTools } = ctx.payload;
  const appUrl = escapeHtml(ctx.publicAppUrl);
  const dashboardUrl = `${ctx.publicAppUrl}/dashboard`;
  const hasContent =
    toolsUsed.length > 0 || deprecationAlerts.length > 0 || trendingTools.length > 0;
  const greeting = userName ? `Hi ${escapeHtml(userName)},` : 'Hi,';

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;line-height:1.3;margin:0 0 10px;color:#111827">Weekly digest</h1>
<p style="margin:0 0 18px;font-size:13px;color:#6b7280">Week of ${escapeHtml(weekStart)}</p>
<p style="margin:0 0 18px">${greeting}</p>
${
  hasContent
    ? `${
        toolsUsed.length > 0
          ? sectionLabel('Most searched this week') +
            toolsTable(
              appUrl,
              toolsUsed.map((t) => toolRow(appUrl, t.tool_name, `${t.count} calls`)),
            )
          : ''
      }${
        deprecationAlerts.length > 0
          ? `${sectionLabel('Deprecation alerts')}<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${deprecationAlerts
              .map(
                (a) =>
                  `<tr><td style="padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;margin-bottom:8px">
                    <p style="margin:0 0 4px;font-weight:600;color:#b91c1c;font-size:14px">${escapeHtml(a.tool_name)} &mdash; ${escapeHtml(a.severity)}</p>
                    <p style="margin:0;color:#7f1d1d;font-size:13px">${escapeHtml(a.details)}</p>
                  </td></tr><tr><td style="height:8px"></td></tr>`,
              )
              .join('')}</table>`
          : ''
      }${
        trendingTools.length > 0
          ? sectionLabel('Trending now') +
            toolsTable(
              appUrl,
              trendingTools.map((t) =>
                toolRow(
                  appUrl,
                  t.tool_name,
                  t.quality_score != null ? `quality ${t.quality_score.toFixed(2)}` : undefined,
                ),
              ),
            )
          : ''
      }`
    : '<p style="margin:0 0 16px">Nothing to report this week &mdash; your stack is quiet, which is usually a good sign.</p>'
}
${renderCtaButton(dashboardUrl, 'Open dashboard')}`;

  const preheader = `Week of ${weekStart} — ${toolsUsed.length} tools used, ${deprecationAlerts.length} alerts.`;
  return {
    subject: `ToolCairn weekly digest — ${weekStart}`,
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
