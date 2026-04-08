import {
  checkIssueSchema,
  refineRequirementSchema,
  verifySuggestionSchema,
} from '@toolcairn/tools';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ToolHandlers } from '../types.js';

export function intelligenceRoutes(handlers: ToolHandlers) {
  const app = new Hono();

  // POST /v1/intelligence/refine — requirement decomposition
  app.post('/refine', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(refineRequirementSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleRefineRequirement(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  // POST /v1/intelligence/verify — suggestion validation
  app.post('/verify', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(verifySuggestionSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleVerifySuggestion(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  // POST /v1/intelligence/issue — GitHub issue check
  app.post('/issue', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(checkIssueSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleCheckIssue(parsed.data);
    return c.json(result, result.isError ? 500 : 200);
  });

  return app;
}
