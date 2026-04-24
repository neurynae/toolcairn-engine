import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, safeUrl, toPlainText } from './_sanitize.js';

export interface ThresholdExhaustedPayload {
  used: number;
  limit: number;
  date: string;
  /** Single-use magic link → /waitlist/join?token=... */
  waitlistJoinUrl: string;
}

export function renderThresholdExhausted(
  ctx: EmailContext<ThresholdExhaustedPayload>,
): RenderedEmail {
  const { used, limit, waitlistJoinUrl } = ctx.payload;
  const appUrl = escapeHtml(ctx.publicAppUrl);
  const billingUrl = `${ctx.publicAppUrl}/billing`;
  const waitlistHref = safeUrl(waitlistJoinUrl);

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">Daily quota reached</h1>
<p style="margin:0 0 16px">You&rsquo;ve used all <strong>${used}/${limit}</strong> of today&rsquo;s ToolCairn calls. MCP tools will return <code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;font-family:SFMono-Regular,Consolas,monospace;font-size:12.5px">429</code> until the counter resets at UTC midnight.</p>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 20px;background:#f8f9fc;border:1px solid #e5e7eb;border-radius:8px">
  <tr>
    <td style="padding:18px 22px">
      <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em">Want uninterrupted access?</p>
      <p style="margin:0;font-size:14px;color:#111827">We&rsquo;re opening a Pro waitlist with the first month on us &mdash; 100 calls/day, priority Stage-0 ranking, and early access to new ecosystem coverage.</p>
    </td>
  </tr>
</table>

${renderCtaButton(waitlistHref, 'Join the waitlist — 1 month free')}

<p style="margin:20px 0 0;font-size:13px;color:#6b7280;text-align:center">One-click join. We&rsquo;ll email you when your slot opens.</p>
<p style="margin:14px 0 0;font-size:13px;color:#6b7280;text-align:center">Or <a href="${escapeHtml(billingUrl)}" style="color:#6366f1;text-decoration:none">upgrade to Pro directly</a> to skip the queue.</p>`;

  const preheader = 'Join the Pro waitlist — first month free.';
  return {
    subject: 'Daily ToolCairn quota reached — skip the wait with free Pro',
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
