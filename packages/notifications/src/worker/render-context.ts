// Builds an EmailContext from the outbox row + current user state.
// Generates a fresh single-use unsubscribe magic-link token per send (except
// weekly digest which uses long-lived tokens — we treat it the same for
// simplicity; expired tokens reject gracefully at redemption).
import { randomBytes } from 'node:crypto';
import { config } from '@toolcairn/config';
import type { PrismaClient } from '@toolcairn/db';
import type { EmailContext, EmailKindValue } from '../types.js';

export interface BuildContextInput {
  prisma: PrismaClient;
  userId: string | null;
  toEmail: string;
  kind: EmailKindValue;
  payload: Record<string, unknown>;
  /** User's displayable name, passed through so templates don't need a DB round-trip. */
  name?: string | null;
}

export async function buildEmailContext(
  input: BuildContextInput,
): Promise<EmailContext<Record<string, unknown>>> {
  const { prisma, userId, toEmail } = input;
  let unsubscribeUrl: string | undefined;

  if (userId) {
    const token = randomBytes(24).toString('base64url');
    await prisma.magicLinkToken.create({
      data: {
        token,
        kind: 'unsubscribe',
        userId,
        email: toEmail,
        expiresAt: new Date(Date.now() + 90 * 86400_000),
        payload: { emailKind: input.kind },
      },
    });
    unsubscribeUrl = `${config.PUBLIC_APP_URL}/email/unsubscribe?token=${token}`;
  }

  return {
    userId,
    toEmail,
    name: input.name ?? null,
    payload: input.payload,
    unsubscribeUrl,
    companyAddress: config.COMPANY_ADDRESS,
    publicAppUrl: config.PUBLIC_APP_URL,
  };
}
