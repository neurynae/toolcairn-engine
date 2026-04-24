// @toolcairn/notifications — transactional email service (outbox + queue + templates)

export type {
  EmailContext,
  EmailKindValue,
  EnqueueOptions,
  PreferenceFlags,
  RenderedEmail,
  TemplateRenderer,
} from './types.js';
export { EmailKind, KIND_PREFERENCE_GATE } from './types.js';

export { enqueueEmail } from './outbox.js';
export { sendEmail, sendBatchEmail } from './transport/resend.js';
export type { ResendSendInput, ResendSendOutcome, ResendBatchOutcome } from './transport/resend.js';
export { runEmailWorker, xaddEmailJob } from './worker/index.js';
export { verifyResendWebhook, handleResendEvent } from './webhook.js';
export type { ResendWebhookEvent, VerifyResult } from './webhook.js';
export { renderTemplate } from './templates/index.js';
