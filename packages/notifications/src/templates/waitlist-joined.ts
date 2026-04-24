import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface WaitlistJoinedPayload {
  name: string | null;
  /** Where the user joined from: daily_limit_email | billing_page | landing_page | self_serve. */
  source: string;
}

/**
 * Sent immediately after a user joins the Pro waitlist.
 * Acknowledges the action, explains why the waitlist exists, and sets the
 * expectation around next steps — so the user isn't left wondering whether
 * the form actually worked.
 */
export function renderWaitlistJoined(ctx: EmailContext<WaitlistJoinedPayload>): RenderedEmail {
  const greeting = ctx.payload.name ? `Hi ${escapeHtml(ctx.payload.name)},` : 'Hi,';
  const dashboardUrl = `${ctx.publicAppUrl}/settings`;

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">You&rsquo;re on the list</h1>
<p style="margin:0 0 14px">${greeting}</p>
<p style="margin:0 0 20px">Thanks for joining the ToolCairn Pro waitlist &mdash; I appreciate the vote of confidence while we&rsquo;re early. We&rsquo;re growing capacity deliberately so every Pro user gets the response quality and uptime the tier promises.</p>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 22px;background:#f8f9fc;border:1px solid #e5e7eb;border-radius:8px">
  <tr>
    <td style="padding:18px 22px">
      <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em">What you&rsquo;ll get when your slot opens</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; <strong>1 month of Pro, on the house</strong> &mdash; no card required to start</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; 100 MCP calls/day (up from 10&ndash;15 on free)</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; Priority Stage-0 recommendations</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; Weekly intelligence digest with trending tools and deprecation alerts</p>
      <p style="margin:0;font-size:14px">&bull; Early access to new ecosystem coverage as we ship it</p>
    </td>
  </tr>
</table>

<p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">What happens next</p>
<p style="margin:0 0 20px;font-size:14px">Slots open in small waves. The moment yours is ready, we&rsquo;ll email you a direct activation link &mdash; nothing for you to do in the meantime. You&rsquo;ll keep your free-tier calls and bonus credits while you wait.</p>

${renderCtaButton(dashboardUrl, 'Open your ToolCairn account')}

<p style="margin:24px 0 0;font-size:13px;color:#6b7280">Have a question, a wishlist item, or a use case you&rsquo;d like us to support? Just reply &mdash; it lands in my inbox.</p>
<p style="margin:8px 0 0;font-size:13px;color:#6b7280">&mdash; The ToolCairn team</p>`;

  const preheader = 'Thanks for joining the ToolCairn Pro waitlist — here&rsquo;s what happens next.';
  return {
    subject: "You're on the ToolCairn Pro waitlist",
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
