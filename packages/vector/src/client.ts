import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '@toolcairn/config';

let _client: QdrantClient | undefined;

export function qdrantClient(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({
      url: config.QDRANT_URL,
      apiKey: config.QDRANT_API_KEY,
    });
  }
  return _client;
}

export async function qdrantHealthCheck(): Promise<{ ok: boolean; message: string }> {
  try {
    await qdrantClient().getCollections();
    return { ok: true, message: 'Qdrant is healthy' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
