// @toolcairn/db — PostgreSQL via Prisma (staging layer + search sessions)
export { PrismaClient } from '@prisma/client';

import { PrismaClient } from '@prisma/client';

// Lazy singleton — PrismaClient is only instantiated when the first property
// is accessed, NOT at module load time. This prevents "DATABASE_URL not found"
// errors during Next.js build on environments that don't need a DB connection
// (e.g. admin Vercel build, which builds without DATABASE_URL).
const globalForPrisma = globalThis as unknown as { _prisma?: PrismaClient };

function getPrismaClient(): PrismaClient {
  if (!globalForPrisma._prisma) {
    globalForPrisma._prisma = new PrismaClient({ log: [] });
  }
  return globalForPrisma._prisma;
}

// biome-ignore lint/suspicious/noExplicitAny: Proxy requires any for property forwarding
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop: string | symbol) {
    return getPrismaClient()[prop as keyof PrismaClient];
  },
});
