import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface ProWaitlistPromoPayload {
  name: string | null;
  dailyLimit: number;
}

/**
 * Sent ~1 hour after the welcome email. Pitches the Pro waitlist with a
 * free-month incentive. Kept soft (not salesy) — one CTA, no repeated asks,
 * unsubscribe prominent in footer.
 */
export function renderProWaitlistPromo(ctx: EmailContext<ProWaitlistPromoPayload>): RenderedEmail {
  const greeting = ctx.payload.name ? `Hi ${escapeHtml(ctx.payload.name)},` : 'Hi,';
  const { dailyLimit } = ctx.payload;
  const waitlistUrl = `${ctx.publicAppUrl}/waitlist?source=welcome_promo`;
  const billingUrl = `${ctx.publicAppUrl}/billing`;

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">Want 10&times; the daily quota?</h1>
<p style="margin:0 0 14px">${greeting}</p>
<p style="margin:0 0 20px">Now that you&rsquo;ve seen ToolCairn, you might&rsquo;ve noticed the free tier (~${dailyLimit} calls/day) is plenty for solo projects but can get tight once an agent gets loose on a real codebase.</p>
<p style="margin:0 0 20px"><strong>We&rsquo;re opening a Pro waitlist with the first month on us.</strong></p>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 22px;background:#f8f9fc;border:1px solid #e5e7eb;border-radius:8px">
  <tr>
    <td style="padding:18px 22px">
      <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em">What Pro unlocks</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; <strong>100</strong> MCP calls per day (plus 100 one-time bonus credits still apply)</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; Priority Stage-0 recommendations &mdash; better tools show up first</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; Weekly intelligence digest &mdash; trending tools, deprecations, stack health</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; Per-tool deprecation alerts via email or webhook</p>
      <p style="margin:0;font-size:14px">&bull; Early access to new ecosystem coverage (Ruby, PHP, Swift, &hellip;)</p>
    </td>
  </tr>
</table>

${renderCtaButton(waitlistUrl, 'Join the waitlist — 1 month free')}

<p style="margin:20px 0 0;font-size:13px;color:#6b7280;text-align:center">One-click join. We email when your slot opens. No credit card required.</p>
<p style="margin:14px 0 0;font-size:13px;color:#6b7280;text-align:center">Or <a href="${escapeHtml(billingUrl)}" style="color:#6366f1;text-decoration:none">subscribe directly</a> to skip the queue.</p>`;

  const preheader = 'Get 1 month of ToolCairn Pro free — join the waitlist.';
  return {
    subject: 'Try ToolCairn Pro free for a month — 100 calls/day + priority ranking',
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
