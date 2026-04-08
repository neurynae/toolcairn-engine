import { searchToolsRespondSchema, searchToolsSchema } from '@toolcairn/tools';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ToolHandlers } from '../types.js';

export function searchRoutes(handlers: ToolHandlers) {
  const app = new Hono();

  // POST /v1/search — full 4-stage pipeline
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(searchToolsSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleSearchTools(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  // POST /v1/search/respond — clarification continuation
  app.post('/respond', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(searchToolsRespondSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleSearchToolsRespond(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  return app;
}
