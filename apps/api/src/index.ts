/**
 * ToolPilot HTTP API — Backend server running on the VPS.
 *
 * All 9 "remote" tools are exposed as HTTP endpoints.
 * The Cloudflare Worker sits in front and handles caching, auth, and rate limiting.
 * This server validates X-Origin-Secret so only the Worker can call it directly.
 */
import { serve } from '@hono/node-server';
import { config } from '@toolcairn/config';
import { prisma } from '@toolcairn/db';
import { createAllHandlers, createDeps } from '@toolcairn/tools';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import pino from 'pino';
import { recordLatency, startLoadMonitor } from './jobs/load-monitor.js';
import { startUsageAggregator } from './jobs/usage-aggregator.js';
import { originAuth } from './middleware/origin-auth.js';
import { adminRoutes } from './routes/admin.js';
import { alertRoutes } from './routes/alerts.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { badgeRoutes } from './routes/badge.js';
import { billingRoutes } from './routes/billing.js';
import { dataRoutes } from './routes/data.js';
import { eventRoutes } from './routes/events.js';
import { feedbackRoutes } from './routes/feedback.js';
import { graphRoutes } from './routes/graph.js';
import { intelligenceRoutes } from './routes/intelligence.js';
import { searchRoutes } from './routes/search.js';
import { systemRoutes } from './routes/system.js';

const logger = pino({ name: '@toolcairn/api' });

// Create shared dependency container once at startup
const deps = createDeps();
const handlers = createAllHandlers(deps);

const app = new Hono();

// Gzip all responses
app.use('*', compress());

// Request logging + latency recording for adaptive rate limiting
app.use('*', async (c, next) => {
  const t0 = Date.now();
  await next();
  const ms = Date.now() - t0;
  recordLatency(ms);
  logger.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms }, 'request');
});

// ── Public endpoints (no origin-auth) ────────────────────────────────────────
app.route('/v1', systemRoutes());
app.route('/v1/auth', authRoutes(prisma));
app.route('/v1/admin', adminRoutes());
// Badge — public SVG badges for README files, cached by CF Worker
app.route('/v1/badge', badgeRoutes());

// ── Protected endpoints — originAuth exempts /v1/billing/webhook automatically ──
app.use('/v1/*', originAuth);
app.route('/v1/data', dataRoutes());
app.route('/v1/events', eventRoutes());
app.route('/v1/analytics', analyticsRoutes());
app.route('/v1/alerts', alertRoutes(prisma));
app.route('/v1/billing', billingRoutes(prisma));
app.route('/v1/search', searchRoutes(handlers));
app.route('/v1/graph', graphRoutes(handlers));
app.route('/v1/intelligence', intelligenceRoutes(handlers));
app.route('/v1/feedback', feedbackRoutes(handlers));

// 404 fallback
app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

// Global error handler
app.onError((err, c) => {
  logger.error({ err }, 'unhandled error');
  return c.json({ error: 'internal_error', message: err.message }, 500);
});

const port = config.MCP_SERVER_PORT ?? 3001;

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'ToolPilot API server started');
  startLoadMonitor();
  startUsageAggregator();
});
