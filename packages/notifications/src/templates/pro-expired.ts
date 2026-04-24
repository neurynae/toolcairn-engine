import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { toPlainText } from './_sanitize.js';

export interface ProExpiredPayload {
  source: 'razorpay_lapse' | 'waitlist_grant_ended' | 'manual';
}

export function renderProExpired(ctx: EmailContext<ProExpiredPayload>): RenderedEmail {
  const billingUrl = `${ctx.publicAppUrl}/billing`;
  const wasGrant = ctx.payload.source === 'waitlist_grant_ended';

  const bodyHtml = `
<h1 style="font-size:20px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">${wasGrant ? 'Your free Pro month has ended' : 'Your Pro subscription has lapsed'}</h1>
<p style="margin:0 0 16px">You&rsquo;re back on the free tier &mdash; 10&ndash;15 calls/day plus any bonus credits remaining. The core tool intelligence graph still works exactly the same.</p>
<p style="margin:0 0 16px">If Pro was a good fit, you can resubscribe any time &mdash; same account, same history:</p>
${renderCtaButton(billingUrl, 'View Pro plans')}
<p style="margin:24px 0 0;font-size:13px;color:#6b7280">Thanks for trying Pro &mdash; any feedback, just hit reply.</p>`;

  const preheader = wasGrant
    ? 'Your free Pro month wrapped up — back to free tier.'
    : 'Subscription lapsed — back to free tier.';
  return {
    subject: wasGrant ? 'Your free Pro month has ended' : 'ToolCairn Pro has lapsed',
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
