import { checkCompatibilitySchema, compareToolsSchema, getStackSchema } from '@toolcairn/tools';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ToolHandlers } from '../types.js';

export function graphRoutes(handlers: ToolHandlers) {
  const app = new Hono();

  // POST /v1/graph/compatibility
  app.post('/compatibility', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(checkCompatibilitySchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleCheckCompatibility(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  // POST /v1/graph/compare
  app.post('/compare', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(compareToolsSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleCompareTools(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  // POST /v1/graph/stack
  app.post('/stack', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(getStackSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleGetStack(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  return app;
}
