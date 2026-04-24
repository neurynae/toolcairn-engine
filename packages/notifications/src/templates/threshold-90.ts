import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface Threshold90Payload {
  used: number;
  limit: number;
  date: string; // YYYY-MM-DD (UTC)
}

export function renderThreshold90(ctx: EmailContext<Threshold90Payload>): RenderedEmail {
  const { used, limit } = ctx.payload;
  const remaining = Math.max(0, limit - used);
  const appUrl = escapeHtml(ctx.publicAppUrl);

  const bodyHtml = `
<h1 style="font-size:20px;font-weight:600;margin:0 0 16px">Heads up — you're at 90% of today's quota</h1>
<p>You've made <strong>${used}</strong> of <strong>${limit}</strong> daily tool calls. ${remaining} left before the limit resets at UTC midnight.</p>
<p>If you're hitting this wall often, Pro gives you 5,000 calls/day plus priority Stage-0 recommendations:</p>
<p style="text-align:center;margin:24px 0">
  <a href="${appUrl}/billing" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">See Pro plans</a>
</p>
<p style="color:#6b7280;font-size:13px">You can silence these warnings in your <a href="${appUrl}/settings" style="color:#6b7280">notification settings</a>.</p>`;

  const html = renderLayout({
    preheader: `${used}/${limit} daily calls used — ${remaining} remaining.`,
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return {
    subject: "You're at 90% of today's ToolCairn quota",
    html,
    text: toPlainText(bodyHtml),
    preheader: `${used}/${limit} daily calls used — ${remaining} remaining.`,
  };
}
