// Thin Resend API wrapper — fetch-only, no SDK dependency.
// https://resend.com/docs/api-reference/emails/send-email
// https://resend.com/docs/api-reference/emails/send-batch-emails
import { config } from '@toolcairn/config';
import { ErrorCode, ExternalServiceError, createLogger } from '@toolcairn/errors';

const logger = createLogger({ name: '@toolcairn/notifications:resend' });

const RESEND_SINGLE = 'https://api.resend.com/emails';
const RESEND_BATCH = 'https://api.resend.com/emails/batch';

export interface ResendTag {
  name: string;
  value: string;
}

export interface ResendSendInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /** From is computed from EMAIL_FROM env; override only for tests. */
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: ResendTag[];
  /** Resend idempotency key — pass EmailEvent.id so provider dedupes on retry. */
  idempotencyKey?: string;
}

export interface ResendSendResult {
  providerMessageId: string;
}

export interface ResendSendOutcome {
  ok: boolean;
  providerMessageId?: string;
  retriable: boolean;
  status: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
}

function buildRequestBody(input: ResendSendInput) {
  return {
    from: input.from ?? config.EMAIL_FROM,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    ...(input.replyTo ? { reply_to: input.replyTo } : { reply_to: config.EMAIL_REPLY_TO }),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
  };
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // HTTP date form — rare for Resend 429s, skip.
  return undefined;
}

/**
 * Single email send. Returns an outcome object (never throws on provider errors —
 * the consumer inspects `retriable` and `status` to decide backoff vs DLQ).
 */
export async function sendEmail(input: ResendSendInput): Promise<ResendSendOutcome> {
  if (!config.RESEND_API_KEY) {
    return {
      ok: false,
      retriable: false,
      status: 0,
      errorCode: ErrorCode.ERR_CONFIG_MISSING,
      errorMessage: 'RESEND_API_KEY not set',
    };
  }

  try {
    const res = await fetch(RESEND_SINGLE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
      },
      body: JSON.stringify(buildRequestBody(input)),
    });

    if (res.ok) {
      const data = (await res.json()) as { id?: string };
      if (!data.id) {
        return {
          ok: false,
          retriable: true,
          status: res.status,
          errorCode: ErrorCode.ERR_EXTERNAL_RESEND,
          errorMessage: 'Resend 2xx but no id in response',
        };
      }
      return { ok: true, providerMessageId: data.id, retriable: false, status: res.status };
    }

    const body = await res.text();
    // 429 → rate-limit, retriable with backoff from header
    if (res.status === 429) {
      return {
        ok: false,
        retriable: true,
        status: res.status,
        errorCode: ErrorCode.ERR_EXTERNAL_RESEND,
        errorMessage: body.slice(0, 500),
        retryAfterMs: parseRetryAfter(res.headers),
      };
    }
    // 5xx → retriable
    if (res.status >= 500) {
      return {
        ok: false,
        retriable: true,
        status: res.status,
        errorCode: ErrorCode.ERR_EXTERNAL_RESEND,
        errorMessage: body.slice(0, 500),
      };
    }
    // 4xx (bad address, validation, etc.) → terminal
    return {
      ok: false,
      retriable: false,
      status: res.status,
      errorCode: ErrorCode.ERR_EXTERNAL_RESEND,
      errorMessage: body.slice(0, 500),
    };
  } catch (e) {
    // Network-level — retriable.
    logger.warn({ err: e }, 'Resend fetch threw (network error)');
    return {
      ok: false,
      retriable: true,
      status: 0,
      errorCode: ErrorCode.ERR_NETWORK_TIMEOUT,
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface ResendBatchInput {
  messages: Omit<ResendSendInput, 'idempotencyKey'>[];
  /** Resend batch supports up to 100 per call. The caller is responsible for chunking. */
}

export interface ResendBatchOutcome {
  ok: boolean;
  providerMessageIds: string[];
  retriable: boolean;
  status: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
}

/**
 * Batch send (up to 100 per call). Used for release announcements and weekly
 * digest fanout to minimise HTTP overhead.
 */
export async function sendBatchEmail(input: ResendBatchInput): Promise<ResendBatchOutcome> {
  if (!config.RESEND_API_KEY) {
    return {
      ok: false,
      providerMessageIds: [],
      retriable: false,
      status: 0,
      errorCode: ErrorCode.ERR_CONFIG_MISSING,
      errorMessage: 'RESEND_API_KEY not set',
    };
  }
  if (input.messages.length === 0) {
    return { ok: true, providerMessageIds: [], retriable: false, status: 200 };
  }
  if (input.messages.length > 100) {
    throw new ExternalServiceError({
      service: 'resend',
      code: ErrorCode.ERR_VALIDATION_INPUT,
      message: 'Resend batch capped at 100 messages per call',
      context: { module: '@toolcairn/notifications', operation: 'sendBatchEmail' },
    });
  }

  try {
    const res = await fetch(RESEND_BATCH, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input.messages.map((m) => buildRequestBody(m))),
    });

    if (res.ok) {
      const data = (await res.json()) as { data?: { id: string }[] };
      const ids = (data.data ?? []).map((d) => d.id);
      return { ok: true, providerMessageIds: ids, retriable: false, status: res.status };
    }

    const body = await res.text();
    const retriable = res.status === 429 || res.status >= 500;
    return {
      ok: false,
      providerMessageIds: [],
      retriable,
      status: res.status,
      errorCode: ErrorCode.ERR_EXTERNAL_RESEND,
      errorMessage: body.slice(0, 500),
      retryAfterMs: res.status === 429 ? parseRetryAfter(res.headers) : undefined,
    };
  } catch (e) {
    logger.warn({ err: e }, 'Resend batch fetch threw');
    return {
      ok: false,
      providerMessageIds: [],
      retriable: true,
      status: 0,
      errorCode: ErrorCode.ERR_NETWORK_TIMEOUT,
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  }
}
