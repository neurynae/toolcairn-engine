import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface ProExpiredPayload {
  source: 'razorpay_lapse' | 'waitlist_grant_ended' | 'manual';
}

export function renderProExpired(ctx: EmailContext<ProExpiredPayload>): RenderedEmail {
  const appUrl = escapeHtml(ctx.publicAppUrl);
  const wasGrant = ctx.payload.source === 'waitlist_grant_ended';

  const bodyHtml = `
<h1 style="font-size:20px;font-weight:600;margin:0 0 16px">${wasGrant ? 'Free Pro month has ended' : 'Your Pro subscription has lapsed'}</h1>
<p>You're back on the free tier — 100–200 calls/day, the core tool intelligence graph still works exactly the same.</p>
<p>If Pro was a good fit, you can resubscribe any time — same account, same history:</p>
<p style="text-align:center;margin:28px 0">
  <a href="${appUrl}/billing" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">View Pro plans</a>
</p>
<p style="color:#6b7280;font-size:13px">Thanks for trying Pro — any feedback, just hit reply.</p>`;

  const html = renderLayout({
    preheader: wasGrant
      ? 'Your free Pro month wrapped up — back to free tier.'
      : 'Subscription lapsed — back to free tier.',
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return {
    subject: wasGrant ? 'Your free Pro month has ended' : 'ToolCairn Pro has lapsed',
    html,
    text: toPlainText(bodyHtml),
  };
}
