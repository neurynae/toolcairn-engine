// Email kind catalog — keep in sync with EmailEvent.kind / EmailOutbox.kind column values.
export const EmailKind = {
  Welcome: 'welcome',
  Threshold90: 'threshold_90',
  ThresholdExhausted: 'threshold_100',
  ProActivated: 'pro_activated',
  ProExpiringSoon: 'pro_expiring_soon',
  ProExpired: 'pro_expired',
  McpRelease: 'mcp_release',
  DeprecationNotice: 'deprecation_notice',
  WeeklyDigest: 'weekly_digest',
} as const;

export type EmailKindValue = (typeof EmailKind)[keyof typeof EmailKind];

// Per-kind preference gate — used by the consumer to decide which User.notify* flag
// the kind should honour before sending. `null` means the kind bypasses opt-out
// (welcome: user just signed up; weekly_digest: has its own emailDigestEnabled flag).
export const KIND_PREFERENCE_GATE: Record<EmailKindValue, keyof PreferenceFlags | null> = {
  welcome: null,
  threshold_90: 'notifyLimitAlerts',
  threshold_100: 'notifyLimitAlerts',
  pro_activated: 'notifyBilling',
  pro_expiring_soon: 'notifyBilling',
  pro_expired: 'notifyBilling',
  mcp_release: 'notifyReleases',
  deprecation_notice: 'notifyReleases',
  weekly_digest: 'emailDigestEnabled',
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
