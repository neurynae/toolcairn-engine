import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface ProActivatedPayload {
  planKey: string | null;
  expiresAt: string | null; // ISO
  source: 'razorpay_webhook' | 'waitlist_grant' | 'manual';
}

export function renderProActivated(ctx: EmailContext<ProActivatedPayload>): RenderedEmail {
  const { planKey, expiresAt, source } = ctx.payload;
  const appUrl = escapeHtml(ctx.publicAppUrl);
  const expiry = expiresAt ? new Date(expiresAt).toUTCString() : 'end of billing cycle';
  const isGrant = source === 'waitlist_grant';

  const headline = isGrant
    ? 'Welcome to Pro — your free month is active'
    : 'Pro is live on your account';

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;margin:0 0 16px">${headline}</h1>
<p>You now have:</p>
<ul style="margin:0 0 20px;padding-left:20px">
  <li><strong>5,000</strong> MCP tool calls per day</li>
  <li>Priority Stage-0 recommendations</li>
  <li>Weekly tool-intelligence digest (opt-in)</li>
  <li>Deprecation alerts on subscribed tools</li>
</ul>
<p>Plan: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px">${escapeHtml(planKey ?? 'pro')}</code></p>
<p>Renews / expires: <strong>${escapeHtml(expiry)}</strong></p>
<p style="text-align:center;margin:32px 0">
  <a href="${appUrl}/settings/billing" style="display:inline-block;padding:10px 22px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500">Manage subscription</a>
</p>
<p style="color:#6b7280;font-size:13px">Questions or billing issues — reply to this email, I'll sort it.</p>`;

  const html = renderLayout({
    preheader: `Pro plan active until ${expiry}.`,
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return {
    subject: isGrant
      ? "You're in — free month of ToolCairn Pro starts now"
      : 'ToolCairn Pro is active',
    html,
    text: toPlainText(bodyHtml),
    preheader: `Pro plan active until ${expiry}.`,
  };
}
