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
import { createLogger } from '@toolcairn/errors';
import { createProdLogger } from '@toolcairn/errors/transports';
import { createAllHandlers, createDeps } from '@toolcairn/tools';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { startEmailOutboxPoller } from './jobs/email-outbox-poller.js';
import { recordLatency, startLoadMonitor } from './jobs/load-monitor.js';
import { startScheduledEmailPoller } from './jobs/scheduled-email-poller.js';
import { startUsageAggregator } from './jobs/usage-aggregator.js';
import { createErrorHandler, requestIdMiddleware } from './middleware/error-handler.js';
import { originAuth } from './middleware/origin-auth.js';
import { adminEmailsRoutes } from './routes/admin-emails.js';
import { adminWaitlistRoutes } from './routes/admin-waitlist.js';
import { adminRoutes } from './routes/admin.js';
import { alertRoutes } from './routes/alerts.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { badgeRoutes } from './routes/badge.js';
import { billingRoutes } from './routes/billing.js';
import { dataRoutes } from './routes/data.js';
import { emailUnsubscribeRoutes } from './routes/email-unsubscribe.js';
import { eventRoutes } from './routes/events.js';
import { feedbackRoutes } from './routes/feedback.js';
import { graphRoutes } from './routes/graph.js';
import { intelligenceRoutes } from './routes/intelligence.js';
import { internalNotificationsRoutes } from './routes/internal-notifications.js';
import { scanRoutes } from './routes/scan.js';
import { searchRoutes } from './routes/search.js';
import { systemRoutes } from './routes/system.js';
import { toolsRoutes } from './routes/tools.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { webhookRoutes } from './routes/webhooks.js';

const logger =
  process.env.NODE_ENV === 'production'
    ? createProdLogger({ name: '@toolcairn/api' })
    : createLogger({ name: '@toolcairn/api' });

// Create shared dependency container once at startup
const deps = createDeps();
const handlers = createAllHandlers(deps);

type AppEnv = { Variables: { requestId: string } };
const app = new Hono<AppEnv>();

// Gzip all responses
app.use('*', compress());

// Assign a unique request ID to every request (reads X-Request-ID from CF Worker or generates one)
app.use('*', requestIdMiddleware);

// Request logging + latency recording for adaptive rate limiting
app.use('*', async (c, next) => {
  const t0 = Date.now();
  await next();
  const ms = Date.now() - t0;
  recordLatency(ms);
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms,
      requestId: c.get('requestId'),
    },
    'request',
  );
});

// ── Public endpoints (no origin-auth) ────────────────────────────────────────
app.route('/v1', systemRoutes());
app.route('/v1/auth', authRoutes(prisma));
app.route('/v1/admin', adminRoutes());
app.route('/v1/admin/emails', adminEmailsRoutes());
app.route('/v1/admin/waitlist', adminWaitlistRoutes());
// Badge — public SVG badges for README files, cached by CF Worker
app.route('/v1/badge', badgeRoutes());
// Webhook sinks — each handler verifies its own provider signature
app.route('/v1/webhooks', webhookRoutes());

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
app.route('/v1/tools', toolsRoutes(handlers));
app.route('/v1/scan', scanRoutes());
app.route('/v1/internal', internalNotificationsRoutes());
app.route('/v1/waitlist', waitlistRoutes());
app.route('/v1/email', emailUnsubscribeRoutes());

// 404 fallback
app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

// Global error handler — structured, code-bearing responses with request ID correlation
app.onError(createErrorHandler(logger));

const port = config.MCP_SERVER_PORT ?? 3001;

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'ToolPilot API server started');
  startLoadMonitor();
  startUsageAggregator();
  startEmailOutboxPoller();
  startScheduledEmailPoller();
});
