import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface BonusCreditHalfwayPayload {
  name: string | null;
  remaining: number;
  starting: number;
}

/**
 * Fires exactly once when a user's bonus-credit pool drops to 50 remaining.
 * Gentle mid-pool nudge — not a limit alert, just heads-up + pitch to Pro.
 */
export function renderBonusCreditHalfway(
  ctx: EmailContext<BonusCreditHalfwayPayload>,
): RenderedEmail {
  const greeting = ctx.payload.name ? `Hi ${escapeHtml(ctx.payload.name)},` : 'Hi,';
  const { remaining, starting } = ctx.payload;
  const waitlistUrl = `${ctx.publicAppUrl}/waitlist?source=bonus_halfway`;
  const billingUrl = `${ctx.publicAppUrl}/billing`;

  const bodyHtml = `
<h1 style="font-size:20px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">Halfway through your bonus credits</h1>
<p style="margin:0 0 14px">${greeting}</p>
<p style="margin:0 0 18px">You&rsquo;ve used <strong>${starting - remaining}</strong> of the <strong>${starting}</strong> one-time bonus credits we granted at signup. <strong>${remaining} remaining.</strong></p>

<p style="margin:0 0 18px">That&rsquo;s genuinely useful &mdash; it means ToolCairn is earning its keep in your workflow. When the pool runs dry, the daily quota keeps working but you&rsquo;ll notice the ceiling.</p>

<p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em">Your options from here</p>
<ul style="margin:0 0 22px;padding-left:22px;font-size:14px;line-height:1.7">
  <li><strong>Keep going on free</strong> &mdash; bonus never expires until used (90-day cap), daily quota resets every UTC midnight.</li>
  <li><strong>Join the Pro waitlist</strong> &mdash; first month complimentary, 100 calls/day, priority ranking.</li>
  <li><strong>Subscribe to Pro now</strong> &mdash; skip the queue, activate today.</li>
</ul>

${renderCtaButton(waitlistUrl, 'Join the Pro waitlist')}

<p style="margin:20px 0 0;font-size:13px;color:#6b7280;text-align:center">Or <a href="${escapeHtml(billingUrl)}" style="color:#6366f1;text-decoration:none">subscribe directly</a> to skip the queue.</p>`;

  const preheader = `${remaining} bonus credits left — here's what happens when the pool runs dry.`;
  return {
    subject: `${remaining} bonus credits left on your ToolCairn account`,
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
