import type { PrismaClient } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
/**
 * Auth routes — device code flow + user management for the web app.
 * These routes do NOT require origin-auth (called by Vercel public app + MCP CLI directly).
 */
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

const logger = createLogger({ name: '@toolcairn/api/auth' });

const USER_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEVICE_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const SALT_ROUNDS = 12;

function randomDeviceCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomUserCode(): string {
  const chars = USER_CODE_CHARS;
  const part = (n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${part(4)}-${part(4)}`;
}

async function mintAccessToken(
  userId: string,
  email: string,
  secret: string,
  tier = 'free',
): Promise<string> {
  return new SignJWT({ sub: userId, email, type: 'mcp', tier })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('90d')
    .sign(new TextEncoder().encode(secret));
}

/** Resolve current plan tier for a user — checks expiry. */
async function getUserTier(prisma: PrismaClient, userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, planExpiresAt: true },
  });
  if (!user) return 'free';
  if (user.plan !== 'free' && user.planExpiresAt && user.planExpiresAt > new Date()) {
    return user.plan;
  }
  return 'free';
}

export function authRoutes(prisma: PrismaClient): Hono {
  const app = new Hono();

  // ── Signup (email + password) ──────────────────────────────────────────────
  // Called by Vercel public app /api/auth/signup route
  app.post('/signup', async (c) => {
    try {
      const body = (await c.req.json()) as { name?: string; email?: string; password?: string };
      if (!body.email || !body.password)
        return c.json({ error: 'email and password required' }, 400);
      if (body.password.length < 8)
        return c.json({ error: 'Password must be at least 8 characters' }, 400);

      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) return c.json({ error: 'An account with this email already exists.' }, 409);

      const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);
      const user = await prisma.user.create({
        data: {
          name: body.name ?? null,
          email: body.email,
          passwordHash,
          accounts: {
            create: {
              type: 'credentials',
              provider: 'credentials',
              providerAccountId: body.email,
            },
          },
        },
        select: { id: true, name: true, email: true, createdAt: true },
      });

      return c.json({ ok: true, user }, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── User CRUD (for Auth.js VpsAdapter) ────────────────────────────────────

  // POST /v1/auth/users — createUser (OAuth sign-in, no password)
  app.post('/users', async (c) => {
    try {
      const body = (await c.req.json()) as {
        email: string;
        name?: string | null;
        emailVerified?: string | null;
        image?: string | null;
      };
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) return c.json(existing);

      const user = await prisma.user.create({
        data: {
          email: body.email,
          name: body.name ?? null,
          emailVerified: body.emailVerified ? new Date(body.emailVerified) : null,
          image: body.image ?? null,
        },
      });
      return c.json(user, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // GET /v1/auth/users/:id — getUser
  app.get('/users/:id', async (c) => {
    const id = c.req.param('id');
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return c.json(null);
    return c.json(user);
  });

  // GET /v1/auth/users?email=xxx — getUserByEmail
  app.get('/users', async (c) => {
    const email = c.req.query('email');
    if (!email) return c.json({ error: 'email query required' }, 400);
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        passwordHash: true,
      },
    });
    return c.json(user ?? null);
  });

  // GET /v1/auth/users/by-account?provider=xxx&providerAccountId=xxx — getUserByAccount
  app.get('/users/by-account', async (c) => {
    const provider = c.req.query('provider');
    const providerAccountId = c.req.query('providerAccountId');
    if (!provider || !providerAccountId) return c.json(null);
    const account = await prisma.account.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      include: { user: true },
    });
    return c.json(account?.user ?? null);
  });

  // PATCH /v1/auth/users/:id — updateUser
  app.patch('/users/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const { passwordHash: _ph, ...safeFields } = body;
      const user = await prisma.user.update({
        where: { id },
        data: safeFields as Parameters<typeof prisma.user.update>[0]['data'],
      });
      return c.json(user);
    } catch {
      return c.json({ error: 'user not found' }, 404);
    }
  });

  // POST /v1/auth/users/:id/accounts — linkAccount
  app.post('/users/:id/accounts', async (c) => {
    try {
      const body = (await c.req.json()) as {
        type: string;
        provider: string;
        providerAccountId: string;
        refresh_token?: string | null;
        access_token?: string | null;
        expires_at?: number | null;
        token_type?: string | null;
        scope?: string | null;
        id_token?: string | null;
        session_state?: string | null;
      };
      const userId = c.req.param('id');
      const account = await prisma.account.create({
        data: { ...body, userId },
      });
      return c.json(account, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── Device code flow ───────────────────────────────────────────────────────

  // POST /v1/auth/device-code — initiate device auth
  app.post('/device-code', async (c) => {
    const appUrl = process.env.AUTH_URL ?? 'https://toolcairn.neurynae.com';

    const deviceCode = randomDeviceCode();
    const userCode = randomUserCode();
    const expiresAt = new Date(Date.now() + DEVICE_CODE_EXPIRY_MS);

    await prisma.deviceCode.create({
      data: { deviceCode, userCode, expiresAt },
    });

    logger.info({ userCode }, 'device code created');

    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${appUrl}/device?code=${userCode}`,
      expires_in: 600,
      interval: 5,
    });
  });

  // POST /v1/auth/token — poll for token after device approval
  app.post('/token', async (c) => {
    const body = (await c.req.json()) as { device_code?: string; grant_type?: string };

    if (body.grant_type !== 'device_code' || !body.device_code) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const record = await prisma.deviceCode.findUnique({
      where: { deviceCode: body.device_code },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    if (!record) return c.json({ error: 'invalid_device_code' }, 400);
    if (new Date() > record.expiresAt || record.status === 'expired') {
      return c.json({ error: 'expired_token' }, 400);
    }
    if (record.status === 'pending') {
      return c.json({ error: 'authorization_pending' }, 400);
    }
    if (record.status !== 'approved' || !record.user) {
      return c.json({ error: 'access_denied' }, 400);
    }

    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return c.json({ error: 'server_misconfigured' }, 500);

    const tier = await getUserTier(prisma, record.user.id);
    const accessToken = await mintAccessToken(
      record.user.id,
      record.user.email ?? '',
      authSecret,
      tier,
    );

    const apiKey = await prisma.apiKey.upsert({
      where: { key: `${record.user.id}-mcp` },
      update: { lastUsed: new Date() },
      create: {
        key: `${record.user.id}-mcp`,
        userId: record.user.id,
        label: 'MCP CLI',
        tier: 'free',
        rateLimit: 60,
      },
    });

    await prisma.deviceCode.update({
      where: { id: record.id },
      data: { status: 'expired' },
    });

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 90 * 24 * 3600,
      api_key: apiKey.key,
      user: { id: record.user.id, name: record.user.name, email: record.user.email },
    });
  });

  // GET /v1/auth/me — return current user from JWT
  app.get('/me', async (c) => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
    try {
      const payload = JSON.parse(atob(auth.slice(7).split('.')[1] ?? ''));
      return c.json({ ok: true, user: { id: payload.sub, email: payload.email } });
    } catch {
      return c.json({ error: 'invalid_token' }, 401);
    }
  });

  // POST /v1/auth/refresh-token — get a new JWT with updated plan tier
  // Called by MCP clients after a user upgrades their plan, without re-authenticating.
  app.post('/refresh-token', async (c) => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return c.json({ error: 'server_misconfigured' }, 500);
    try {
      const payload = JSON.parse(atob(auth.slice(7).split('.')[1] ?? ''));
      const userId = payload.sub as string;
      if (!userId) return c.json({ error: 'invalid_token' }, 401);
      const tier = await getUserTier(prisma, userId);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      const accessToken = await mintAccessToken(userId, user?.email ?? '', authSecret, tier);
      return c.json({ access_token: accessToken, tier, expires_in: 90 * 24 * 3600 });
    } catch {
      return c.json({ error: 'invalid_token' }, 401);
    }
  });

  // PATCH /v1/auth/preferences — update user notification preferences (Pro gate for digest)
  app.patch('/preferences', async (c) => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
    try {
      const payload = JSON.parse(atob(auth.slice(7).split('.')[1] ?? ''));
      const userId = payload.sub as string;
      if (!userId) return c.json({ error: 'invalid_token' }, 401);

      const body = (await c.req.json()) as { emailDigestEnabled?: boolean };

      // Pro gate for email digest
      if (body.emailDigestEnabled === true) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { plan: true, planExpiresAt: true },
        });
        const isPro = user?.plan === 'pro' && user.planExpiresAt && user.planExpiresAt > new Date();
        if (!isPro) {
          return c.json(
            {
              ok: false,
              error: 'pro_required',
              message: 'Weekly digest requires a Pro plan. Upgrade at /billing',
            },
            403,
          );
        }
      }

      await prisma.user.update({
        where: { id: userId },
        data: { emailDigestEnabled: body.emailDigestEnabled },
      });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'invalid_token' }, 401);
    }
  });

  // POST /v1/auth/device/approve — approve a device code (called by Vercel consent page)
  app.post('/device/approve', async (c) => {
    try {
      const body = (await c.req.json()) as { userCode?: string; userId?: string };
      const userCode = body.userCode?.trim().toUpperCase();
      if (!userCode || !body.userId) {
        return c.json({ error: 'userCode and userId required' }, 400);
      }

      const record = await prisma.deviceCode.findUnique({ where: { userCode } });
      if (!record) return c.json({ error: 'Invalid or expired code' }, 404);
      if (record.status !== 'pending')
        return c.json({ error: 'Code already used or expired' }, 409);
      if (new Date() > record.expiresAt) {
        await prisma.deviceCode.update({ where: { id: record.id }, data: { status: 'expired' } });
        return c.json({ error: 'Code has expired' }, 410);
      }

      await prisma.deviceCode.update({
        where: { id: record.id },
        data: { status: 'approved', userId: body.userId },
      });

      logger.info({ userCode }, 'device approved');
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // Cleanup expired device codes on startup
  prisma.deviceCode
    .updateMany({
      where: { status: 'pending', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    })
    .catch(() => {});

  return app;
}
