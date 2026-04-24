// Weekly digest — migrated from apps/indexer/src/email/templates/weekly-digest.ts
// and adapted to the new template protocol (returns {subject, html, text}).
import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface WeeklyDigestPayload {
  userName: string | null;
  weekStart: string; // "Apr 7, 2026"
  toolsUsed: Array<{ tool_name: string; count: number }>;
  deprecationAlerts: Array<{ tool_name: string; severity: string; details: string }>;
  trendingTools: Array<{ tool_name: string; quality_score: number | null }>;
}

function toolLink(name: string, appUrl: string, badge?: string): string {
  return `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0f0f0">
        <a href="${appUrl}/tool/${encodeURIComponent(name)}" style="color:#6366f1;text-decoration:none;font-weight:500">${escapeHtml(name)}</a>
        ${badge ? `<span style="margin-left:8px;font-size:11px;color:#888">${escapeHtml(badge)}</span>` : ''}
      </td>
    </tr>`;
}

function section(title: string, content: string): string {
  return `
    <div style="margin:24px 0">
      <h2 style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin:0 0 12px">${escapeHtml(title)}</h2>
      ${content}
    </div>`;
}

export function renderWeeklyDigest(ctx: EmailContext<WeeklyDigestPayload>): RenderedEmail {
  const { userName, weekStart, toolsUsed, deprecationAlerts, trendingTools } = ctx.payload;
  const appUrl = escapeHtml(ctx.publicAppUrl);
  const hasContent =
    toolsUsed.length > 0 || deprecationAlerts.length > 0 || trendingTools.length > 0;
  const greeting = userName ? `Hey ${escapeHtml(userName)},` : 'Hey,';

  const toolsUsedSection =
    toolsUsed.length > 0
      ? section(
          'Most searched this week',
          `<table style="width:100%;border-collapse:collapse">${toolsUsed.map((t) => toolLink(t.tool_name, appUrl, `${t.count} calls`)).join('')}</table>`,
        )
      : '';

  const deprecationSection =
    deprecationAlerts.length > 0
      ? section(
          'Deprecation alerts',
          `<table style="width:100%;border-collapse:collapse">${deprecationAlerts
            .map(
              (a) =>
                `<tr><td style="padding:12px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:4px"><div style="font-weight:600;color:#b91c1c">${escapeHtml(a.tool_name)} — ${escapeHtml(a.severity)}</div><div style="margin-top:4px;color:#7f1d1d;font-size:13px">${escapeHtml(a.details)}</div></td></tr>`,
            )
            .join('')}</table>`,
        )
      : '';

  const trendingSection =
    trendingTools.length > 0
      ? section(
          'Trending now',
          `<table style="width:100%;border-collapse:collapse">${trendingTools
            .map((t) =>
              toolLink(
                t.tool_name,
                appUrl,
                t.quality_score != null ? `quality ${t.quality_score.toFixed(2)}` : undefined,
              ),
            )
            .join('')}</table>`,
        )
      : '';

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;margin:0 0 16px">ToolCairn weekly digest</h1>
<p>${greeting}</p>
<p style="color:#6b7280">Week of ${escapeHtml(weekStart)}</p>
${
  hasContent
    ? `${toolsUsedSection}${deprecationSection}${trendingSection}`
    : '<p>Nothing to report this week — your stack is quiet, which is usually a good sign.</p>'
}
<p style="text-align:center;margin:32px 0">
  <a href="${appUrl}/dashboard" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">Open dashboard</a>
</p>`;

  const html = renderLayout({
    preheader: `Week of ${weekStart} — ${toolsUsed.length} tools used, ${deprecationAlerts.length} alerts.`,
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return {
    subject: `ToolCairn weekly digest — ${weekStart}`,
    html,
    text: toPlainText(bodyHtml),
  };
}
