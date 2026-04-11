import { config } from '@toolcairn/config';
import { VectorError } from './errors.js';

const NOMIC_API_URL = 'https://api-atlas.nomic.ai/v1/embedding/text';
const NOMIC_MODEL = 'nomic-embed-text-v1.5';
const BATCH_SIZE = 50;

export type EmbedTaskType = 'search_document' | 'search_query' | 'classification';

export async function embedText(
  text: string,
  taskType: EmbedTaskType = 'search_document',
): Promise<number[]> {
  const results = await embedBatch([text], taskType);
  const result = results[0];
  if (!result) throw new VectorError({ message: 'embedText: no embedding returned' });
  return result;
}

export async function embedBatch(
  texts: string[],
  taskType: EmbedTaskType = 'search_document',
): Promise<number[][]> {
  const apiKey = config.NOMIC_API_KEY;
  if (!apiKey) throw new VectorError({ message: 'NOMIC_API_KEY is not configured' });

  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await fetch(NOMIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: NOMIC_MODEL,
        texts: batch,
        task_type: taskType,
      }),
    });

    if (!response.ok) {
      throw new VectorError({ message: `Nomic API error: ${response.status} ${response.statusText}` });
    }

    const data = (await response.json()) as { embeddings: number[][] };
    embeddings.push(...data.embeddings);
  }

  return embeddings;
}

/** Canonical text for embedding a ToolNode.
 * Uses topics instead of category — category is a derived field that can
 * be wrong; topics are the ground truth from GitHub maintainers.
 */
export function toolEmbedText(name: string, description: string, topics?: string[]): string {
  const topicText = topics && topics.length > 0 ? `\nTopics: ${topics.join(', ')}` : '';
  return `${name}\n${description}${topicText}`;
}
