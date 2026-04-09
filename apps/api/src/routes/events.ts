/**
 * Event ingestion endpoint — POST /v1/events
 *
 * Receives lightweight tool-call events from MCP clients (via CF Worker).
 * Writes to McpEvent asynchronously; responds 202 immediately to never
 * block MCP tool responses.
 */

import { prisma } from '@toolcairn/db';
import { Hono } from 'hono';
import { z } from 'zod';

const EventSchema = z.object({
  tool_name: z.string().min(1).max(128),
  query_id: z.string().uuid().optional(),
  duration_ms: z.number().int().min(0).default(0),
  status: z.enum(['ok', 'error']).default('ok'),
  metadata: z.record(z.unknown()).optional(),
});

export function eventRoutes() {
  const app = new Hono();

  app.post('/', async (c) => {
    // Read user_id from the header set by the CF Worker
    const userId = c.req.header('X-ToolCairn-User-Id') ?? null;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const parsed = EventSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'validation_error', message: parsed.error.issues[0]?.message },
        400,
      );
    }

    // Fire-and-forget: kick off write but don't block the response.
    // Analytics loss is acceptable; never delay MCP tool responses.
    prisma.mcpEvent
      .create({
        data: {
          tool_name: parsed.data.tool_name,
          query_id: parsed.data.query_id ?? null,
          user_id: userId,
          duration_ms: parsed.data.duration_ms,
          status: parsed.data.status,
          // biome-ignore lint/suspicious/noExplicitAny: Prisma Json field requires cast from Record<string,unknown>
          metadata: parsed.data.metadata as any,
        },
      })
      .catch(() => undefined);

    return c.json({ ok: true }, 202);
  });

  return app;
}
