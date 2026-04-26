import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface ProActivatedPayload {
  planKey: string | null;
  expiresAt: string | null;
  source: 'razorpay_webhook' | 'waitlist_grant' | 'manual';
}

export function renderProActivated(ctx: EmailContext<ProActivatedPayload>): RenderedEmail {
  const { planKey, expiresAt, source } = ctx.payload;
  const _appUrl = escapeHtml(ctx.publicAppUrl);
  const billingUrl = `${ctx.publicAppUrl}/settings`;
  const expiry = expiresAt ? new Date(expiresAt).toUTCString() : 'end of billing cycle';
  const isGrant = source === 'waitlist_grant';

  const headline = isGrant
    ? 'Welcome to Pro — your free month is active'
    : 'Pro is live on your account';

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">${headline}</h1>
<p style="margin:0 0 16px">You now have:</p>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 22px;background:#f8f9fc;border:1px solid #e5e7eb;border-radius:8px">
  <tr>
    <td style="padding:18px 22px">
      <p style="margin:0 0 8px;font-size:14px">&bull; <strong>100</strong> MCP tool calls per day</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; Priority Stage-0 recommendations</p>
      <p style="margin:0 0 8px;font-size:14px">&bull; Weekly intelligence digest (opt-in)</p>
      <p style="margin:0;font-size:14px">&bull; Deprecation alerts on subscribed tools</p>
    </td>
  </tr>
</table>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px">
  <tr>
    <td style="padding:0 0 6px;font-size:13px;color:#6b7280">Plan</td>
  </tr>
  <tr>
    <td style="font-size:14px"><code style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:SFMono-Regular,Consolas,monospace;font-size:12.5px">${escapeHtml(planKey ?? 'pro')}</code></td>
  </tr>
  <tr>
    <td style="padding:14px 0 6px;font-size:13px;color:#6b7280">${isGrant ? 'Expires' : 'Renews / expires'}</td>
  </tr>
  <tr>
    <td style="font-size:14px"><strong>${escapeHtml(expiry)}</strong></td>
  </tr>
</table>

${renderCtaButton(billingUrl, 'Manage subscription')}

<p style="margin:24px 0 0;font-size:13px;color:#6b7280">Questions or billing issues &mdash; just reply to this email.</p>`;

  const preheader = `Pro plan active until ${expiry}.`;
  return {
    subject: isGrant
      ? "You're in — free month of ToolCairn Pro starts now"
      : 'ToolCairn Pro is active',
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
