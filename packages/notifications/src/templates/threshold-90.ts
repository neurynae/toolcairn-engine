import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
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
  const billingUrl = `${ctx.publicAppUrl}/billing`;

  const bodyHtml = `
<h1 style="font-size:20px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">You&rsquo;re at 90% of today&rsquo;s quota</h1>
<p style="margin:0 0 16px">You&rsquo;ve made <strong>${used}</strong> of <strong>${limit}</strong> daily tool calls. <strong>${remaining} left</strong> before the limit resets at UTC midnight.</p>
<p style="margin:0 0 20px">If this keeps happening, Pro gives you 5,000 calls/day plus priority Stage-0 recommendations.</p>
${renderCtaButton(billingUrl, 'View Pro plans')}
<p style="margin:20px 0 0;font-size:13px;color:#6b7280;text-align:center">You can silence quota warnings in your <a href="${appUrl}/settings" style="color:#6b7280;text-decoration:underline">notification settings</a>.</p>`;

  const preheader = `${used}/${limit} daily calls used — ${remaining} remaining.`;
  return {
    subject: "You're at 90% of today's ToolCairn quota",
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
