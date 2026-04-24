import type { EmailContext, RenderedEmail } from '../types.js';
import { renderCtaButton, renderLayout } from './_layout.js';
import { escapeHtml, toPlainText } from './_sanitize.js';

export interface ReferralAcceptedPayload {
  /** Inviter's displayable name. */
  name: string | null;
  /** The person who just signed up with the inviter's link. Privacy-friendly: first name only. */
  inviteeName: string | null;
  /** Bonus amount granted to the inviter. */
  inviterBonus: number;
  /** Running total of bonus credits available to the inviter (post-grant). */
  inviterBalance: number;
}

/**
 * Sent to the INVITER when someone signs up using their referral code.
 * Tone: warm acknowledgement, clear credit update, nudge to invite more.
 */
export function renderReferralAccepted(ctx: EmailContext<ReferralAcceptedPayload>): RenderedEmail {
  const greeting = ctx.payload.name ? `Hi ${escapeHtml(ctx.payload.name)},` : 'Hi,';
  const { inviteeName, inviterBonus, inviterBalance } = ctx.payload;
  const referUrl = `${ctx.publicAppUrl}/refer`;

  // Use first name only if provided, else a neutral phrase.
  const who = inviteeName ? escapeHtml(inviteeName.split(' ')[0] ?? '') : 'Someone you invited';

  const bodyHtml = `
<h1 style="font-size:22px;font-weight:600;line-height:1.3;margin:0 0 16px;color:#111827">+${inviterBonus} bonus credits for both of you</h1>
<p style="margin:0 0 14px">${greeting}</p>
<p style="margin:0 0 18px">${who} just signed up with your referral link &mdash; thanks for spreading the word. We&rsquo;ve credited <strong>+${inviterBonus}</strong> to your bonus pool as a thank-you.</p>

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 22px;background:#f8f9fc;border:1px solid #e5e7eb;border-radius:8px">
  <tr>
    <td style="padding:18px 22px">
      <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em">Your bonus pool now</p>
      <p style="margin:0;font-size:20px;font-weight:600;color:#111827">${inviterBalance} credits</p>
    </td>
  </tr>
</table>

<p style="margin:0 0 18px">Each successful referral earns you another ${inviterBonus} on top &mdash; and the person you invite lands with a head start, which is good for them too.</p>

${renderCtaButton(referUrl, 'Invite more people')}

<p style="margin:24px 0 0;font-size:13px;color:#6b7280">Thanks for putting ToolCairn in front of your network &mdash; it matters at this stage.</p>
<p style="margin:8px 0 0;font-size:13px;color:#6b7280">&mdash; The ToolCairn team</p>`;

  const preheader = `${who} joined with your link — +${inviterBonus} credits added to your pool.`;
  return {
    subject: `+${inviterBonus} bonus credits — someone joined with your ToolCairn referral`,
    html: renderLayout({ preheader, bodyHtml, unsubscribeUrl: ctx.unsubscribeUrl }),
    text: toPlainText(bodyHtml),
    preheader,
  };
}
