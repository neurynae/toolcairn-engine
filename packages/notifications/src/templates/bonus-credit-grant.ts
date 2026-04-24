import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface BonusCreditGrantPayload {
  name: string | null;
  /** Starting bonus grant — typically 100. */
  bonusCredits: number;
  /** Current daily free-tier cap for context (10–15 at publish time). */
  dailyLimit: number;
}

/**
 * Sent ~2 minutes after the welcome email. Educates new users on how the
 * bonus-credit pool works so the first time they hit the daily cap isn't a
 * surprise. Informational — no hard sell.
 */
export function renderBonusCreditGrant(ctx: EmailContext<BonusCreditGrantPayload>): RenderedEmail {
  const greeting = ctx.payload.name ? `Hi ${escapeHtml(ctx.payload.name)},` : 'Hi,';
  const { bonusCredits, dailyLimit } = ctx.payload;
  const billingUrl = `${ctx.publicAppUrl}/billing`;

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">You have ${bonusCredits} bonus calls waiting</h1>
<p style="margin:0 0 14px">${greeting}</p>
<p style="margin:0 0 18px">A quick heads-up on how your free-tier calls are structured &mdash; so the first time you hit the daily ceiling isn&rsquo;t a surprise.</p>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 20px;background:#f8f9fc;border:1px solid #e5e7eb;border-radius:8px">
  <tr>
    <td style="padding:18px 22px">
      <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em">Daily bucket</p>
      <p style="margin:0 0 14px;font-size:14px;color:#111827"><strong>${dailyLimit}</strong> calls / day &mdash; resets at UTC midnight.</p>

      <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em">Bonus bucket (you just received this)</p>
      <p style="margin:0;font-size:14px;color:#111827"><strong>${bonusCredits}</strong> one-time credits. Never expires. Only taps in <em>after</em> your daily bucket is spent, so you won&rsquo;t burn through it by accident.</p>
    </td>
  </tr>
</table>

<p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">How it plays out in practice</p>
<ol style="margin:0 0 22px;padding-left:22px;font-size:14px;line-height:1.7">
  <li>Calls 1&ndash;${dailyLimit} each day come out of your daily bucket.</li>
  <li>Past ${dailyLimit}, each call spends one credit from your bonus pool.</li>
  <li>The daily bucket refills every UTC midnight; the bonus pool doesn&rsquo;t.</li>
  <li>When both are empty, we&rsquo;ll show your agent a friendly message (not a hard error) with a link to Pro.</li>
</ol>

${renderCtaButton(billingUrl, 'See your balance')}

<p style="margin:24px 0 0;font-size:13px;color:#6b7280">Any questions, reply to this email &mdash; I&rsquo;m listening.</p>
<p style="margin:8px 0 0;font-size:13px;color:#6b7280">&mdash; The ToolCairn team</p>`;

  const preheader = `${bonusCredits} one-time bonus calls — here's how the pool works.`;
  return {
    subject: `You have ${bonusCredits} bonus calls waiting — here's how they work`,
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
