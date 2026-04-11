/**
 * Thin Resend API wrapper — no SDK dependency, just fetch.
 * https://resend.com/docs/api-reference/emails/send-email
 */

import { config } from '@toolcairn/config';
import { createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/indexer:resend' });

const RESEND_API = 'https://api.resend.com/emails';
const FROM = 'ToolCairn <digest@neurynae.com>';

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  if (!config.RESEND_API_KEY) {
    logger.warn('RESEND_API_KEY not set — skipping email send');
    return false;
  }

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error({ status: res.status, err, to: payload.to }, 'Resend error');
      return false;
    }

    logger.info({ to: payload.to, subject: payload.subject }, 'Email sent');
    return true;
  } catch (e) {
    logger.error({ err: e, to: payload.to }, 'Resend fetch failed');
    return false;
  }
}
