import type { EmailContext, RenderedEmail } from '../types.js';
import { renderLayout } from './_layout.js';
import { escapeHtml, safeUrl, toPlainText } from './_sanitize.js';

export interface ThresholdExhaustedPayload {
  used: number;
  limit: number;
  date: string;
  /** One-time-use magic link → /waitlist/join?token=... (pre-signed by enqueuer). */
  waitlistJoinUrl: string;
}

export function renderThresholdExhausted(
  ctx: EmailContext<ThresholdExhaustedPayload>,
): RenderedEmail {
  const { used, limit, waitlistJoinUrl } = ctx.payload;
  const appUrl = escapeHtml(ctx.publicAppUrl);
  const waitlistHref = escapeHtml(safeUrl(waitlistJoinUrl));

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;margin:0 0 16px">Daily quota reached — resets at UTC midnight</h1>
<p>You've used all <strong>${used}/${limit}</strong> of today's ToolCairn calls. MCP tools will return <code>429</code> until midnight UTC.</p>
<p style="margin:24px 0 8px"><strong>Want uninterrupted access?</strong></p>
<p>We're opening a Pro waitlist with the first month on us — 5,000 calls/day, priority Stage-0 ranking, and early access to upcoming ecosystem coverage.</p>
<p style="text-align:center;margin:32px 0">
  <a href="${waitlistHref}"
     style="display:inline-block;padding:12px 28px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
    Join the waitlist — 1 month Pro free
  </a>
</p>
<p style="color:#6b7280;font-size:13px">One-click join. We'll email you when your slot opens.</p>
<p style="color:#6b7280;font-size:13px">Or <a href="${appUrl}/billing" style="color:#6b7280">upgrade to Pro directly</a> to skip the queue.</p>`;

  const html = renderLayout({
    preheader: 'Join the Pro waitlist — first month free.',
    bodyHtml,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });

  return {
    subject: 'Daily ToolCairn quota reached — skip the wait with free Pro',
    html,
    text: toPlainText(bodyHtml),
    preheader: 'Join the Pro waitlist — first month free.',
  };
}
