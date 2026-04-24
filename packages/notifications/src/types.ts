// Email kind catalog — keep in sync with EmailEvent.kind / EmailOutbox.kind column values.
export const EmailKind = {
  Welcome: 'welcome',
  BonusCreditGrant: 'bonus_credit_grant',
  BonusCreditHalfway: 'bonus_credit_halfway',
  ProWaitlistPromo: 'pro_waitlist_promo',
  WaitlistJoined: 'waitlist_joined',
  ReferralAccepted: 'referral_accepted',
  Threshold90: 'threshold_90',
  ThresholdExhausted: 'threshold_100',
  ProActivated: 'pro_activated',
  ProExpiringSoon: 'pro_expiring_soon',
  ProExpired: 'pro_expired',
  McpRelease: 'mcp_release',
  DeprecationNotice: 'deprecation_notice',
  WeeklyDigest: 'weekly_digest',
  DeliverabilityAlert: 'deliverability_alert',
} as const;

export type EmailKindValue = (typeof EmailKind)[keyof typeof EmailKind];

// Per-kind preference gate — used by the consumer to decide which User.notify* flag
// the kind should honour before sending. `null` means the kind bypasses opt-out
// (welcome: user just signed up; weekly_digest: has its own emailDigestEnabled flag).
export const KIND_PREFERENCE_GATE: Record<EmailKindValue, keyof PreferenceFlags | null> = {
  welcome: null,
  // Bonus-credit grant is a one-time onboarding explainer — informational,
  // not marketing, so it bypasses preference gates like `welcome` does.
  bonus_credit_grant: null,
  // Halfway alert fires once when the pool drops to 50 remaining. Treated
  // as a usage alert (same bucket as the daily 90/100 warnings).
  bonus_credit_halfway: 'notifyLimitAlerts',
  // Waitlist promo is a one-time post-signup nudge — gated on notifyBilling so
  // users who opt out of billing-adjacent emails never receive it.
  pro_waitlist_promo: 'notifyBilling',
  // Waitlist thank-you is a direct confirmation of a user action — same
  // treatment as welcome/bonus-grant (bypasses preference gates).
  waitlist_joined: null,
  // Referral acceptance — direct confirmation of a user action (someone
  // signed up with their code). Bypasses preference gates.
  referral_accepted: null,
  threshold_90: 'notifyLimitAlerts',
  threshold_100: 'notifyLimitAlerts',
  pro_activated: 'notifyBilling',
  pro_expiring_soon: 'notifyBilling',
  pro_expired: 'notifyBilling',
  mcp_release: 'notifyReleases',
  deprecation_notice: 'notifyReleases',
  weekly_digest: 'emailDigestEnabled',
  // Deliverability alerts go to the admin mailbox — bypass preferences so
  // the admin can't accidentally unsubscribe from their own ops alerts.
  deliverability_alert: null,
};

export interface PreferenceFlags {
  notifyLimitAlerts: boolean;
  notifyReleases: boolean;
  notifyBilling: boolean;
  emailDigestEnabled: boolean;
  emailDoNotEmail: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  preheader?: string;
}

export interface EmailContext<TPayload = Record<string, unknown>> {
  userId?: string | null;
  toEmail: string;
  name?: string | null;
  payload: TPayload;
  unsubscribeUrl?: string;
  companyAddress: string;
  publicAppUrl: string;
}

export type TemplateRenderer<TPayload = Record<string, unknown>> = (
  ctx: EmailContext<TPayload>,
) => RenderedEmail;

export interface EnqueueOptions {
  kind: EmailKindValue;
  userId?: string | null;
  toEmail: string;
  scopeKey?: string;
  payload: Record<string, unknown>;
  requestId?: string | null;
  /** When set, writes to ScheduledEmail instead of EmailOutbox. Released by the scheduled-email poller. */
  scheduledFor?: Date;
}
