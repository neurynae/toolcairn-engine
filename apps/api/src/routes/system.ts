import { Hono } from 'hono';
import { getCurrentLoad } from '../jobs/load-monitor.js';

export function systemRoutes() {
  const app = new Hono();

  // GET /v1/health — health check (used by Cloudflare Worker origin probe)
  app.get('/health', (c) => {
    return c.json({ ok: true, service: 'toolpilot-api', ts: new Date().toISOString() });
  });

  // GET /v1/system/load — current system load + adaptive free-tier limit
  // Public endpoint — CF Worker cron fetches this every minute and caches in KV.
  app.get('/system/load', (c) => {
    return c.json({ ok: true, data: getCurrentLoad() });
  });

  // POST /v1/register — anonymous API key registration
  // The Worker stores these in KV; the API just acknowledges
  app.post('/register', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const clientId = typeof body.client_id === 'string' ? body.client_id : crypto.randomUUID();
    return c.json({ ok: true, client_id: clientId });
  });

  return app;
}
