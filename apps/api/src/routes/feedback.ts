import { reportOutcomeSchema, suggestGraphUpdateSchema } from '@toolcairn/tools';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ToolHandlers } from '../types.js';

export function feedbackRoutes(handlers: ToolHandlers) {
  const app = new Hono();

  // POST /v1/feedback/outcome — record tool usage outcome
  app.post('/outcome', async (c) => {
    const body = await c.req.json().catch(() => null);
    // Inject user_id from header if not provided in body (CF Worker propagates it)
    const headerUserId = c.req.header('X-ToolCairn-User-Id');
    const bodyWithUser =
      body && headerUserId && !body.user_id ? { ...body, user_id: headerUserId } : body;
    const parsed = z.object(reportOutcomeSchema).safeParse(bodyWithUser);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleReportOutcome(parsed.data);
    // Always return 202 Accepted for fire-and-forget semantics
    return c.json(result, 202);
  });

  // POST /v1/feedback/suggest — graph update suggestion
  app.post('/suggest', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(suggestGraphUpdateSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleSuggestGraphUpdate(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  return app;
}
