import type { PrismaClient } from '@toolcairn/db';
import type { ClarificationAnswer, ClarificationQuestion, SearchContext } from './types.js';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Prisma 6 JSON field type — used to cast Json/JsonNullable fields for writes
type JsonInput = unknown;

export class SearchSessionManager {
  constructor(private readonly prisma: PrismaClient) {}

  async createSession(query: string): Promise<string> {
    const session = await this.prisma.searchSession.create({
      data: {
        query,
        context: {},
        clarification_history: [],
        stage: 1,
        status: 'active',
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return session.id;
  }

  async getSession(id: string) {
    return this.prisma.searchSession.findUnique({ where: { id } });
  }

  async appendClarification(
    sessionId: string,
    questions: ClarificationQuestion[],
    answers: ClarificationAnswer[],
  ): Promise<void> {
    const session = await this.prisma.searchSession.findUniqueOrThrow({
      where: { id: sessionId },
    });

    const history = [
      ...(session.clarification_history as unknown[]),
      { questions, answers, timestamp: new Date().toISOString() },
    ] as JsonInput;

    await this.prisma.searchSession.update({
      where: { id: sessionId },
      data: {
        // biome-ignore lint/suspicious/noExplicitAny: Prisma 6 Json[] field
        clarification_history: history as any,
        stage: session.stage + 1,
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
        updated_at: new Date(),
      },
    });
  }

  async saveResults(sessionId: string, results: unknown): Promise<void> {
    await this.prisma.searchSession.update({
      where: { id: sessionId },
      data: {
        // biome-ignore lint/suspicious/noExplicitAny: Prisma 6 Json field
        results: results as any,
        status: 'completed',
        updated_at: new Date(),
      },
    });
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.prisma.searchSession.update({
      where: { id: sessionId },
      data: {
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
        updated_at: new Date(),
      },
    });
  }

  async updateContext(sessionId: string, context: SearchContext): Promise<void> {
    await this.prisma.searchSession.update({
      where: { id: sessionId },
      data: {
        // biome-ignore lint/suspicious/noExplicitAny: Prisma 6 Json field
        context: context as any,
        updated_at: new Date(),
      },
    });
  }

  async saveCandidates(sessionId: string, ids: string[]): Promise<void> {
    const session = await this.prisma.searchSession.findUnique({ where: { id: sessionId } });
    const existing = (session?.context as Record<string, unknown> | null) ?? {};
    await this.prisma.searchSession.update({
      where: { id: sessionId },
      data: {
        // biome-ignore lint/suspicious/noExplicitAny: Prisma 6 Json field
        context: { ...existing, stage1_ids: ids } as any,
        updated_at: new Date(),
      },
    });
  }

  async getCandidates(sessionId: string): Promise<string[]> {
    const session = await this.prisma.searchSession.findUnique({ where: { id: sessionId } });
    const ctx = session?.context as Record<string, unknown> | null;
    const ids = ctx?.stage1_ids;
    return Array.isArray(ids) ? (ids as string[]) : [];
  }

  async getAskedDimensions(sessionId: string): Promise<Set<string>> {
    const session = await this.prisma.searchSession.findUnique({ where: { id: sessionId } });
    const history = session?.clarification_history as Array<{
      questions: Array<{ dimension: string }>;
    }> | null;
    const dims = new Set<string>();
    if (Array.isArray(history)) {
      for (const entry of history) {
        for (const q of entry.questions ?? []) {
          if (q.dimension) dims.add(q.dimension);
        }
      }
    }
    return dims;
  }
}
