import { Hono } from 'hono';

export function systemRoutes() {
  const app = new Hono();

  // GET /v1/health — health check (used by Cloudflare Worker origin probe)
  app.get('/health', (c) => {
    return c.json({ ok: true, service: 'toolpilot-api', ts: new Date().toISOString() });
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
