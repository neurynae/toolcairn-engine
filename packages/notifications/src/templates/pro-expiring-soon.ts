import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface ProExpiringSoonPayload {
  planKey: string | null;
  expiresAt: string; // ISO
  /** When source='waitlist_grant', expiry reverts to free tier (not renewal). */
  source: 'razorpay' | 'waitlist_grant' | 'manual';
}

export function renderProExpiringSoon(ctx: EmailContext<ProExpiringSoonPayload>): RenderedEmail {
  const { expiresAt, source } = ctx.payload;
  const appUrl = escapeHtml(ctx.publicAppUrl);
  const expiry = new Date(expiresAt).toUTCString();
  const isGrant = source === 'waitlist_grant';

  const bodyHtml = isGrant
    ? `
<h1 style="font-size:20px;font-weight:600;margin:0 0 16px">Your free Pro month ends in 7 days</h1>
<p>Your complimentary month of ToolCairn Pro wraps up on <strong>${escapeHtml(expiry)}</strong>. After that, your account reverts to the free tier (100–200 calls/day).</p>
<p>Like how Pro fits your workflow? Keep the quota and priority ranking:</p>
<p style="text-align:center;margin:28px 0">
  <a href="${appUrl}/billing" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">Subscribe to Pro</a>
</p>
<p style="color:#6b7280;font-size:13px">No pressure — the free tier keeps working without interruption either way.</p>`
    : `
<h1 style="font-size:20px;font-weight:600;margin:0 0 16px">Pro renews in 7 days</h1>
<p>Your ToolCairn Pro subscription renews on <strong>${escapeHtml(expiry)}</strong>. Nothing to do — this is just a heads-up.</p>
<p style="text-align:center;margin:28px 0">
  <a href="${appUrl}/settings/billing" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">Manage subscription</a>
</p>`;

  const subject = isGrant ? 'Your free Pro month ends in 7 days' : 'ToolCairn Pro renews in 7 days';

  const html = renderLayout({
    preheader: subject,
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return { subject, html, text: toPlainText(bodyHtml), preheader: subject };
}
