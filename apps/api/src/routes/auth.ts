import { type PrismaClient, prisma } from '@toolcairn/db';
import { createLogger } from '@toolcairn/errors';
import { EmailKind, enqueueEmail } from '@toolcairn/notifications';
/**
 * Auth routes — device code flow + user management for the web app.
 * These routes do NOT require origin-auth (called by Vercel public app + MCP CLI directly).
 */
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { getCurrentLoad } from '../jobs/load-monitor.js';

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

// Cheap UUID shape check — signup/resolveReferrer treats anything non-UUID
// as "no referral" without bothering Postgres.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a referral code to the inviter record. Returns null (no referral)
 * if the code is missing, malformed, doesn't exist, or points at the same
 * email as the new signup (self-referral attempt).
 */
async function resolveReferrer(
  referralCode: string | undefined | null,
  signupEmail: string | undefined | null,
): Promise<{ id: string; email: string; name: string | null } | null> {
  if (!referralCode || !UUID_RE.test(referralCode)) return null;
  const inviter = await prisma.user.findUnique({
    where: { id: referralCode },
    select: { id: true, email: true, name: true },
  });
  if (!inviter) return null;
  if (signupEmail && inviter.email.trim().toLowerCase() === signupEmail.trim().toLowerCase()) {
    return null;
  }
  return inviter;
}

/**
 * Apply a referral grant inside the provided transaction: creates a
 * ReferralGrant row (UNIQUE on inviter+invitee — duplicates silently rejected),
 * +50 bonus credits to both users, and enqueues the referral_accepted email
 * to the inviter. Returns the invitee's new bonus balance.
 */
async function applyReferralGrant(
  tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  inviter: { id: string; email: string; name: string | null },
  invitee: { id: string; email: string; name: string | null },
): Promise<number> {
  const BONUS = 50;

  // UNIQUE(inviter, invitee) — skip silently if it somehow fires twice.
  try {
    await tx.referralGrant.create({
      data: {
        inviterUserId: inviter.id,
        inviteeUserId: invitee.id,
        inviterBonus: BONUS,
        inviteeBonus: BONUS,
      },
    });
  } catch {
    // Already granted — return the invitee's current balance without double-bumping.
    const u = await tx.user.findUnique({
      where: { id: invitee.id },
      select: { bonusCreditRemaining: true },
    });
    return u?.bonusCreditRemaining ?? 0;
  }

  const [, bumpedInvitee, bumpedInviter] = await Promise.all([
    tx.user.update({
      where: { id: inviter.id },
      data: { bonusCreditRemaining: { increment: BONUS } },
      select: { bonusCreditRemaining: true },
    }),
    tx.user.update({
      where: { id: invitee.id },
      data: { bonusCreditRemaining: { increment: BONUS } },
      select: { bonusCreditRemaining: true },
    }),
    tx.user.findUnique({
      where: { id: inviter.id },
      select: { bonusCreditRemaining: true },
    }),
  ]);

  await enqueueEmail(tx, {
    kind: EmailKind.ReferralAccepted,
    userId: inviter.id,
    toEmail: inviter.email,
    scopeKey: `invite:${invitee.id}`,
    payload: {
      name: inviter.name,
      inviteeName: invitee.name,
      inviterBonus: BONUS,
      inviterBalance: bumpedInviter?.bonusCreditRemaining ?? 0,
    },
  });

  return bumpedInvitee.bonusCreditRemaining;
}

export function authRoutes(prisma: PrismaClient): Hono {
  const app = new Hono();

  // ── Signup (email + password) ──────────────────────────────────────────────
  // Called by Vercel public app /api/auth/signup route
  app.post('/signup', async (c) => {
    try {
      const body = (await c.req.json()) as {
        name?: string;
        email?: string;
        password?: string;
        /** Referral code = inviter's userId. Validated below; invalid codes are silently ignored. */
        referralCode?: string;
      };
      if (!body.email || !body.password)
        return c.json({ error: 'email and password required' }, 400);
      if (body.password.length < 8)
        return c.json({ error: 'Password must be at least 8 characters' }, 400);

      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) return c.json({ error: 'An account with this email already exists.' }, 409);

      // Resolve referral — only accept if (a) the code is a valid UUID, (b) it
      // maps to a real user, and (c) that user's email isn't the same as the
      // signup email (blocks trivial self-referral).
      const inviter = await resolveReferrer(body.referralCode, body.email);

      const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);
      const user = await prisma.$transaction(async (tx) => {
        const expiresAt = new Date(Date.now() + 90 * 86_400_000);
        const created = await tx.user.create({
          data: {
            name: body.name ?? null,
            email: body.email ?? '',
            passwordHash,
            bonusCreditExpiresAt: expiresAt,
            referredByUserId: inviter?.id ?? null,
            accounts: {
              create: {
                type: 'credentials',
                provider: 'credentials',
                providerAccountId: body.email ?? '',
              },
            },
          },
          select: {
            id: true,
            name: true,
            email: true,
            createdAt: true,
            bonusCreditRemaining: true,
          },
        });
        const dailyLimit = getCurrentLoad().free_tier_limit;
        let bonusCredits = created.bonusCreditRemaining;

        // Apply referral grant inside the same tx (if any). +50 to both.
        if (inviter) {
          bonusCredits = await applyReferralGrant(tx, inviter, created);
        }

        await enqueueEmail(tx, {
          kind: EmailKind.Welcome,
          userId: created.id,
          toEmail: created.email,
          scopeKey: '',
          payload: { name: created.name, dailyLimit },
        });
        await enqueueEmail(tx, {
          kind: EmailKind.BonusCreditGrant,
          userId: created.id,
          toEmail: created.email,
          scopeKey: '',
          payload: { name: created.name, dailyLimit, bonusCredits },
          scheduledFor: new Date(Date.now() + 90 * 1000),
        });
        await enqueueEmail(tx, {
          kind: EmailKind.ProWaitlistPromo,
          userId: created.id,
          toEmail: created.email,
          scopeKey: '',
          payload: { name: created.name, dailyLimit },
          scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
        });
        return created;
      });

      return c.json({ ok: true, user }, 201);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── Referral stats (for /refer page) ──────────────────────────────────────
  app.get('/referral-stats/:userId', async (c) => {
    const userId = c.req.param('userId');
    if (!userId) return c.json({ error: 'userId required' }, 400);
    try {
      const [user, grants] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, bonusCreditRemaining: true, bonusCreditExpiresAt: true },
        }),
        prisma.referralGrant.findMany({
          where: { inviterUserId: userId },
          select: { createdAt: true, inviterBonus: true },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      if (!user) return c.json({ error: 'user_not_found' }, 404);
      const totalEarned = grants.reduce((sum, g) => sum + g.inviterBonus, 0);
      return c.json({
        ok: true,
        data: {
          referralCode: user.id, // userId IS the referral code (MVP — can shorten later)
          inviteCount: grants.length,
          totalBonusEarned: totalEarned,
          bonusCreditRemaining: user.bonusCreditRemaining,
          bonusCreditExpiresAt: user.bonusCreditExpiresAt?.toISOString() ?? null,
        },
      });
    } catch {
      return c.json({ error: 'internal' }, 500);
    }
  });

  // ── User CRUD (for Auth.js VpsAdapter) ────────────────────────────────────

  // POST /v1/auth/users — createUser (OAuth sign-in, no password)
  // Accepts optional `referralCode` — Auth.js passes it through via the
  // VpsAdapter when the OAuth flow started with a ?ref= URL parameter.
  app.post('/users', async (c) => {
    try {
      const body = (await c.req.json()) as {
        email: string;
        name?: string | null;
        emailVerified?: string | null;
        image?: string | null;
        referralCode?: string;
      };
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) return c.json(existing);

      const inviter = await resolveReferrer(body.referralCode, body.email);

      const user = await prisma.$transaction(async (tx) => {
        const expiresAt = new Date(Date.now() + 90 * 86_400_000);
        const created = await tx.user.create({
          data: {
            email: body.email,
            name: body.name ?? null,
            emailVerified: body.emailVerified ? new Date(body.emailVerified) : null,
            image: body.image ?? null,
            bonusCreditExpiresAt: expiresAt,
            referredByUserId: inviter?.id ?? null,
          },
        });
        if (inviter) {
          await applyReferralGrant(tx, inviter, created);
        }
        const dailyLimit = getCurrentLoad().free_tier_limit;
        const bonusCredits = created.bonusCreditRemaining;
        await enqueueEmail(tx, {
          kind: EmailKind.Welcome,
          userId: created.id,
          toEmail: created.email,
          scopeKey: '',
          payload: { name: created.name, dailyLimit },
        });
        await enqueueEmail(tx, {
          kind: EmailKind.BonusCreditGrant,
          userId: created.id,
          toEmail: created.email,
          scopeKey: '',
          payload: { name: created.name, dailyLimit, bonusCredits },
          scheduledFor: new Date(Date.now() + 90 * 1000),
        });
        await enqueueEmail(tx, {
          kind: EmailKind.ProWaitlistPromo,
          userId: created.id,
          toEmail: created.email,
          scopeKey: '',
          payload: { name: created.name, dailyLimit },
          scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
        });
        return created;
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
