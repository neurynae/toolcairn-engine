/**
 * Weekly digest email HTML template.
 * Inline styles only — email clients don't support external CSS.
 */

export interface DigestData {
  userName: string;
  userEmail: string;
  weekStart: string; // "Apr 7, 2026"
  toolsUsed: Array<{ tool_name: string; count: number }>;
  deprecationAlerts: Array<{ tool_name: string; severity: string; details: string }>;
  trendingTools: Array<{ tool_name: string; quality_score: number | null }>;
  unsubscribeToken: string;
}

const APP_URL = 'https://toolcairn.neurynae.com';

function toolRow(name: string, badge?: string): string {
  return `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0f0f0">
        <a href="${APP_URL}/tool/${encodeURIComponent(name)}"
           style="color:#6366f1;text-decoration:none;font-weight:500">${name}</a>
        ${badge ? `<span style="margin-left:8px;font-size:11px;color:#888">${badge}</span>` : ''}
      </td>
    </tr>`;
}

function section(title: string, content: string): string {
  return `
    <div style="margin:24px 0">
      <h2 style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;
                 color:#888;margin:0 0 12px">${title}</h2>
      ${content}
    </div>`;
}

export function buildWeeklyDigestHtml(data: DigestData): string {
  const hasContent =
    data.toolsUsed.length > 0 || data.deprecationAlerts.length > 0 || data.trendingTools.length > 0;

  if (!hasContent) return ''; // skip empty digest

  const toolsSection =
    data.toolsUsed.length > 0
      ? section(
          'Your Tools This Week',
          `<table style="width:100%;border-collapse:collapse">
            ${data.toolsUsed.map((t) => toolRow(t.tool_name, `${t.count}× used`)).join('')}
          </table>`,
        )
      : '';

  const alertsSection =
    data.deprecationAlerts.length > 0
      ? section(
          '⚠️ Deprecation Alerts',
          `<table style="width:100%;border-collapse:collapse">
            ${data.deprecationAlerts
              .map((a) =>
                toolRow(
                  a.tool_name,
                  `<span style="color:${a.severity === 'critical' ? '#ef4444' : '#eab308'}">${a.severity}</span> — ${a.details.slice(0, 60)}…`,
                ),
              )
              .join('')}
          </table>`,
        )
      : '';

  const trendingSection =
    data.trendingTools.length > 0
      ? section(
          'Trending This Week',
          `<table style="width:100%;border-collapse:collapse">
            ${data.trendingTools
              .map((t) => toolRow(t.tool_name, t.quality_score ? `Score: ${t.quality_score}` : ''))
              .join('')}
          </table>`,
        )
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;max-width:600px">

        <!-- Header -->
        <tr style="background:#4f46e5">
          <td style="padding:24px 32px">
            <span style="color:#fff;font-size:20px;font-weight:700">ToolCairn</span>
            <span style="color:#a5b4fc;font-size:13px;margin-left:12px">Weekly Digest</span>
          </td>
        </tr>

        <!-- Body -->
        <tr><td style="padding:24px 32px;color:#111">
          <p style="margin:0 0 8px;font-size:15px">
            Hi ${data.userName || data.userEmail.split('@')[0]},
          </p>
          <p style="margin:0 0 24px;color:#6b7280;font-size:13px">
            Here's your ToolCairn summary for the week of ${data.weekStart}.
          </p>

          ${toolsSection}
          ${alertsSection}
          ${trendingSection}

          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;
                      font-size:12px;color:#9ca3af;text-align:center">
            <a href="${APP_URL}" style="color:#6366f1;text-decoration:none">toolcairn.neurynae.com</a>
            &nbsp;·&nbsp;
            <a href="${APP_URL}/settings?unsubscribe=${data.unsubscribeToken}"
               style="color:#9ca3af;text-decoration:none">Unsubscribe</a>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
