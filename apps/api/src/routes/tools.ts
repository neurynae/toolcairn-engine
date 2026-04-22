import { batchResolveSchema } from '@toolcairn/tools';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ToolHandlers } from '../types.js';

export function toolsRoutes(handlers: ToolHandlers) {
  const app = new Hono();

  // POST /v1/tools/batch-resolve — classify (ecosystem, name) tuples against the graph
  app.post('/batch-resolve', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object(batchResolveSchema).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 400);
    }
    const result = await handlers.handleBatchResolve(parsed.data);
    if (result.isError) {
      return c.json(result, 500);
    }
    // Unwrap the CallToolResult wire format for direct HTTP consumption.
    // The handler's okResult returns `{ content: [{ type:'text', text: JSON.stringify({ok,data}) }] }`.
    // Downstream MCP clients call toolcairn_init which calls remote.batchResolve which
    // hits this endpoint and expects `{ resolved: [...] }` directly.
    try {
      const textContent = result.content?.find((c) => c.type === 'text');
      if (textContent && textContent.type === 'text') {
        const parsed = JSON.parse(textContent.text) as { ok: boolean; data?: unknown };
        if (parsed.ok && parsed.data) {
          return c.json(parsed.data, 200);
        }
      }
      return c.json(result, 200);
    } catch {
      return c.json(result, 200);
    }
  });

  return app;
}
