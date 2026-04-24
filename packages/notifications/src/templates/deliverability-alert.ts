import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface DeliverabilityAlertPayload {
  severity: 'warn' | 'critical';
  windowDays: number;
  total: number;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  bounceRate: number;
  complaintRate: number;
  bounceSeverity: 'warn' | 'critical' | 'ok';
  complaintSeverity: 'warn' | 'critical' | 'ok';
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * Internal ops alert to the admin mailbox when bounce or complaint rates cross
 * warn / critical thresholds. Plain, dense, no marketing styling.
 */
export function renderDeliverabilityAlert(
  ctx: EmailContext<DeliverabilityAlertPayload>,
): RenderedEmail {
  const p = ctx.payload;
  const severityColor = p.severity === 'critical' ? '#ef4444' : '#f59e0b';
  const severityLabel = p.severity.toUpperCase();

  function row(label: string, value: string | number, highlight?: 'warn' | 'critical' | 'ok') {
    const color =
      highlight === 'critical' ? '#ef4444' : highlight === 'warn' ? '#f59e0b' : '#111827';
    return `<tr>
      <td style="padding:6px 0;font-size:13px;color:#6b7280">${escapeHtml(label)}</td>
      <td style="padding:6px 0;font-size:13px;font-family:SFMono-Regular,Consolas,monospace;color:${color};text-align:right">${escapeHtml(String(value))}</td>
    </tr>`;
  }

  const bodyHtml = `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 14px">
  <tr>
    <td style="background:${severityColor};padding:3px 10px;border-radius:999px;color:#ffffff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em">${severityLabel}</td>
  </tr>
</table>
<h1 style="font-size:20px;font-weight:600;line-height:1.3;margin:0 0 10px;color:#111827">Deliverability thresholds breached</h1>
<p style="margin:0 0 18px;font-size:13px;color:#6b7280">Last ${p.windowDays} days of EmailEvent aggregates.</p>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
  ${row('Total events', p.total)}
  ${row('Delivered', p.delivered)}
  ${row('Sent (no webhook yet)', p.sent)}
  ${row('Bounced', p.bounced, p.bounceSeverity)}
  ${row('Complained', p.complained, p.complaintSeverity)}
  ${row('Failed (retries exhausted)', p.failed)}
</table>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 22px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
  ${row('Bounce rate', pct(p.bounceRate), p.bounceSeverity)}
  ${row('Complaint rate', pct(p.complaintRate), p.complaintSeverity)}
</table>

<p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">Action items</p>
<ul style="margin:0 0 18px;padding-left:22px;font-size:14px;line-height:1.7">
  ${p.bounceSeverity !== 'ok' ? '<li>Check Resend Logs → filter bounced. Look for repeat failing addresses and add them to EmailSuppression manually if the webhook missed them.</li>' : ''}
  ${p.complaintSeverity !== 'ok' ? '<li>Check which email kinds have the most complaints (admin UI → Email History, filter status=complained). May need to soften marketing copy or tighten the opt-in flow.</li>' : ''}
  <li>If critical: consider pausing non-essential kinds (<code>NOTIFICATIONS_ENABLED=false</code>) until reputation recovers.</li>
</ul>

<p style="margin:0;font-size:13px;color:#6b7280">Thresholds: bounce &gt; 2% (warn) / &gt; 5% (critical); complaint &gt; 0.1% (warn) / &gt; 0.3% (critical).</p>`;

  const preheader = `[${severityLabel}] ToolCairn email health: bounce ${pct(p.bounceRate)}, complaint ${pct(p.complaintRate)}.`;
  return {
    subject: `[${severityLabel}] ToolCairn deliverability — bounce ${pct(p.bounceRate)} / complaint ${pct(p.complaintRate)}`,
    html: renderLayout({
      preheader,
      bodyHtml,
      unsubscribeUrl: ctx.unsubscribeUrl,
      hideUnsubscribe: true,
    }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
