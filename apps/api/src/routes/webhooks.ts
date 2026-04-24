// External webhook sinks. Currently: Resend email delivery events.
// Mounted at /v1/webhooks/*; bypasses origin-auth via the PUBLIC_PATHS list
// in middleware/origin-auth.ts. Each webhook handler MUST verify its own
// provider-specific signature.
import { createLogger } from '@toolcairn/errors';
import { handleResendEvent, verifyResendWebhook } from '@toolcairn/notifications';
import { Hono } from 'hono';

const logger = createLogger({ name: '@toolcairn/api:webhooks' });

export function webhookRoutes(): Hono {
  const app = new Hono();

  app.post('/resend', async (c) => {
    const rawBody = await c.req.text();
    const result = verifyResendWebhook(rawBody, {
      'svix-id': c.req.header('svix-id'),
      'svix-timestamp': c.req.header('svix-timestamp'),
      'svix-signature': c.req.header('svix-signature'),
    });
    if (!result.ok || !result.event) {
      logger.warn({ errorMessage: result.errorMessage }, 'Resend webhook verification failed');
      return c.json({ ok: false, error: 'invalid_signature' }, 401);
    }
    try {
      await handleResendEvent(result.event);
    } catch (e) {
      logger.error({ err: e, type: result.event.type }, 'handleResendEvent threw');
      // Return 200 anyway — we've recorded enough state; 500 makes Resend retry unproductively
    }
    return c.json({ ok: true });
  });

  return app;
}
