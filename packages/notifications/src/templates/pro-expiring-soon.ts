import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface ProExpiringSoonPayload {
  planKey: string | null;
  expiresAt: string;
  source: 'razorpay' | 'waitlist_grant' | 'manual';
}

export function renderProExpiringSoon(ctx: EmailContext<ProExpiringSoonPayload>): RenderedEmail {
  const { expiresAt, source } = ctx.payload;
  const _appUrl = escapeHtml(ctx.publicAppUrl);
  const billingUrl = `${ctx.publicAppUrl}/billing`;
  const settingsUrl = `${ctx.publicAppUrl}/settings`;
  const expiry = new Date(expiresAt).toUTCString();
  const isGrant = source === 'waitlist_grant';

  const bodyHtml = isGrant
    ? `
<h1 style="font-size:20px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">Your free Pro month ends in 7 days</h1>
<p style="margin:0 0 16px">Your complimentary month of ToolCairn Pro wraps up on <strong>${escapeHtml(expiry)}</strong>. After that, your account reverts to the free tier (10&ndash;15 calls/day plus any bonus credits).</p>
<p style="margin:0 0 16px">Like how Pro fits your workflow? Keep the quota and priority ranking:</p>
${renderCtaButton(billingUrl, 'Subscribe to Pro')}
<p style="margin:20px 0 0;font-size:13px;color:#6b7280;text-align:center">No pressure &mdash; the free tier keeps working without interruption either way.</p>`
    : `
<h1 style="font-size:20px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">Pro renews in 7 days</h1>
<p style="margin:0 0 16px">Your ToolCairn Pro subscription renews on <strong>${escapeHtml(expiry)}</strong>. Nothing to do &mdash; this is just a heads-up.</p>
${renderCtaButton(settingsUrl, 'Manage subscription')}`;

  const subject = isGrant ? 'Your free Pro month ends in 7 days' : 'ToolCairn Pro renews in 7 days';

  return {
    subject,
    html: renderLayout({ preheader: subject, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader: subject,
  };
}
