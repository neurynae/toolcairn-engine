/**
 * Shared schema for a single row of the tools-keywords JSONL file.
 *
 * Used by:
 *   - apps/indexer/src/upload-keywords.ts (CLI batch uploader)
 *   - apps/api/src/routes/admin-keywords.ts (admin /v1/admin/keywords/ingest)
 *
 * keyword_sentence lives on Qdrant tool payloads only — never in Memgraph.
 * Updates are applied via client.setPayload() (NOT upsert — upsert wipes
 * the rest of the payload; see qdrant-upsert-wipes-payload feedback rule).
 */
import { z } from 'zod';

export const keywordRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  keyword_sentence: z.string().min(1),
});

export type KeywordRow = z.infer<typeof keywordRowSchema>;
