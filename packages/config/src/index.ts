import { z } from 'zod';

const configSchema = z.object({
  // ── Memgraph ──────────────────────────────────────────────────────────────
  MEMGRAPH_URL: z.string().default('bolt://localhost:7687'),
  MEMGRAPH_USER: z.string().default(''),
  MEMGRAPH_PASSWORD: z.string().default(''),

  // ── Qdrant ────────────────────────────────────────────────────────────────
  QDRANT_URL: z.string().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional(),

  // ── PostgreSQL ────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().default('postgresql://toolpilot:toolpilot@localhost:5432/toolpilot'),

  // ── Redis ─────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ── Nomic Embed Code ──────────────────────────────────────────────────────
  NOMIC_API_KEY: z.string().optional(),

  // ── GitHub (Indexer) ──────────────────────────────────────────────────────
  GITHUB_TOKEN: z.string().optional(),

  // ── MCP Server ────────────────────────────────────────────────────────────
  MCP_SERVER_PORT: z.coerce.number().int().positive().default(3001),
  MCP_SERVER_HOST: z.string().default('0.0.0.0'),

  // ── Web App ───────────────────────────────────────────────────────────────
  NEXT_PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  ADMIN_SECRET: z.string().default('change-me-in-production'),

  // ── Deployment Mode ───────────────────────────────────────────────────────
  /** dev: direct Docker DB connections | production: HTTP client to remote API */
  TOOLPILOT_MODE: z.enum(['dev', 'staging', 'production']).default('dev'),
  /** URL of the ToolPilot HTTP API (used when TOOLPILOT_MODE=production) */
  TOOLPILOT_API_URL: z.string().default('https://api.neurynae.com'),
  /** Secret shared between Cloudflare Worker and the API origin server */
  ORIGIN_SECRET: z.string().optional(),

  // ── Resend (Email) ────────────────────────────────────────────────────────
  RESEND_API_KEY: z.string().optional(),

  // ── Razorpay (Billing) ────────────────────────────────────────────────────
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_PLAN_MONTHLY: z.string().optional(),
  RAZORPAY_PLAN_QUARTERLY: z.string().optional(),
  RAZORPAY_PLAN_SEMIANNUAL: z.string().optional(),

  // ── General ───────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

/** Validated, typed configuration loaded from environment variables. */
export const config: Config = loadConfig();
