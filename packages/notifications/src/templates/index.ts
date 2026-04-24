import type { EmailContext, EmailKindValue, RenderedEmail } from '../types.js';
import { EmailKind } from '../types.js';
import { renderBonusCreditGrant } from './bonus-credit-grant.js';
import { renderBonusCreditHalfway } from './bonus-credit-halfway.js';
import { renderDeliverabilityAlert } from './deliverability-alert.js';
import { renderDeprecationNotice } from './deprecation-notice.js';
import { renderMcpRelease } from './mcp-release.js';
import { renderProActivated } from './pro-activated.js';
import { renderProExpired } from './pro-expired.js';
import { renderProExpiringSoon } from './pro-expiring-soon.js';
import { renderProWaitlistPromo } from './pro-waitlist-promo.js';
import { renderReferralAccepted } from './referral-accepted.js';
import { renderThreshold90 } from './threshold-90.js';
import { renderThresholdExhausted } from './threshold-exhausted.js';
import { renderWaitlistJoined } from './waitlist-joined.js';
import { renderWeeklyDigest } from './weekly-digest.js';
import { renderWelcome } from './welcome.js';

export { escapeHtml, safeUrl, toPlainText } from './_sanitize.js';
export { renderCtaButton, renderLayout } from './_layout.js';
export { renderWelcome };
export { renderBonusCreditGrant };
export { renderBonusCreditHalfway };
export { renderProWaitlistPromo };
export { renderWaitlistJoined };
export { renderReferralAccepted };
export { renderThreshold90 };
export { renderThresholdExhausted };
export { renderProActivated };
export { renderProExpiringSoon };
export { renderProExpired };
export { renderMcpRelease };
export { renderDeprecationNotice };
export { renderWeeklyDigest };
export { renderDeliverabilityAlert };

/**
 * Dispatch by kind — returns the rendered email for any EmailKind.
 * Context payload is unchecked at this boundary (template casts to its own payload
 * type); the caller is responsible for constructing a payload that matches the
 * kind. Worker + preview endpoint use this single entry point.
 */
export function renderTemplate(
  kind: EmailKindValue,
  ctx: EmailContext<Record<string, unknown>>,
): RenderedEmail {
  switch (kind) {
    case EmailKind.Welcome:
      return renderWelcome(ctx as EmailContext<never>);
    case EmailKind.BonusCreditGrant:
      return renderBonusCreditGrant(ctx as EmailContext<never>);
    case EmailKind.BonusCreditHalfway:
      return renderBonusCreditHalfway(ctx as EmailContext<never>);
    case EmailKind.ProWaitlistPromo:
      return renderProWaitlistPromo(ctx as EmailContext<never>);
    case EmailKind.WaitlistJoined:
      return renderWaitlistJoined(ctx as EmailContext<never>);
    case EmailKind.ReferralAccepted:
      return renderReferralAccepted(ctx as EmailContext<never>);
    case EmailKind.Threshold90:
      return renderThreshold90(ctx as EmailContext<never>);
    case EmailKind.ThresholdExhausted:
      return renderThresholdExhausted(ctx as EmailContext<never>);
    case EmailKind.ProActivated:
      return renderProActivated(ctx as EmailContext<never>);
    case EmailKind.ProExpiringSoon:
      return renderProExpiringSoon(ctx as EmailContext<never>);
    case EmailKind.ProExpired:
      return renderProExpired(ctx as EmailContext<never>);
    case EmailKind.McpRelease:
      return renderMcpRelease(ctx as EmailContext<never>);
    case EmailKind.DeprecationNotice:
      return renderDeprecationNotice(ctx as EmailContext<never>);
    case EmailKind.WeeklyDigest:
      return renderWeeklyDigest(ctx as EmailContext<never>);
    case EmailKind.DeliverabilityAlert:
      return renderDeliverabilityAlert(ctx as EmailContext<never>);
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown email kind: ${String(_exhaustive)}`);
    }
  }
}
