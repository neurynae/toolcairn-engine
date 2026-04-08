import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock ioredis before importing the module under test ──────────────────────

const mockXreadgroup = vi.fn();
const mockXgroup = vi.fn();
const mockXack = vi.fn();

vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    xreadgroup: mockXreadgroup,
    xgroup: mockXgroup,
    xack: mockXack,
  }));
  return {
    default: MockRedis,
    Redis: MockRedis,
  };
});

// Also mock @toolcairn/config so it doesn't attempt process.env validation
vi.mock('@toolcairn/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
}));

// Import *after* mocks are in place
import { readFromStream } from './consumer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INDEX_STREAM = 'toolpilot:index';
const SEARCH_STREAM = 'toolpilot:search';

/** Build the raw xreadgroup return value for a single stream entry. */
function makeXreadgroupResult(
  streamKey: string,
  entries: Array<{ entryId: string; fields: Record<string, string> }>,
) {
  const rawEntries = entries.map(({ entryId, fields }) => {
    const flatFields = Object.entries(fields).flat();
    return [entryId, flatFields];
  });
  return [[streamKey, rawEntries]];
}

function makeIndexEntry(entryId: string, toolId: string) {
  return makeXreadgroupResult(INDEX_STREAM, [
    {
      entryId,
      fields: {
        id: `msg-${entryId}`,
        type: 'index-job',
        payload: JSON.stringify({ toolId, priority: 1 }),
        timestamp: String(Date.now()),
      },
    },
  ]);
}

function makeSearchEntry(entryId: string, query: string) {
  return makeXreadgroupResult(SEARCH_STREAM, [
    {
      entryId,
      fields: {
        id: `msg-${entryId}`,
        type: 'search-event',
        payload: JSON.stringify({ query, sessionId: 'sess-1' }),
        timestamp: String(Date.now()),
      },
    },
  ]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('readFromStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockXgroup.mockResolvedValue('OK');
  });

  describe('xack routing invariant', () => {
    it('should tag messages from INDEX_STREAM with the index stream key', async () => {
      mockXreadgroup
        .mockResolvedValueOnce(makeIndexEntry('1-0', 'tool-abc'))
        .mockResolvedValueOnce(null); // no search messages

      const messages = await readFromStream('test-group', 'consumer-1', 10);

      const indexMessages = messages.filter((m) => m._streamKey === INDEX_STREAM);
      const searchMessages = messages.filter((m) => m._streamKey === SEARCH_STREAM);

      expect(indexMessages.length).toBe(1);
      expect(searchMessages.length).toBe(0);
      expect(indexMessages[0]?._entryId).toBe('1-0');
    });

    it('should tag messages from SEARCH_STREAM with the search stream key', async () => {
      mockXreadgroup
        .mockResolvedValueOnce(null) // no index messages
        .mockResolvedValueOnce(makeSearchEntry('2-0', 'vector search'));

      const messages = await readFromStream('test-group', 'consumer-1', 10);

      const indexMessages = messages.filter((m) => m._streamKey === INDEX_STREAM);
      const searchMessages = messages.filter((m) => m._streamKey === SEARCH_STREAM);

      expect(searchMessages.length).toBe(1);
      expect(indexMessages.length).toBe(0);
      expect(searchMessages[0]?._entryId).toBe('2-0');
    });

    it('should never mix stream keys — index entry id must not appear on search stream key', async () => {
      mockXreadgroup
        .mockResolvedValueOnce(makeIndexEntry('index-entry-1', 'tool-xyz'))
        .mockResolvedValueOnce(makeSearchEntry('search-entry-1', 'test query'));

      const messages = await readFromStream('test-group', 'consumer-1', 10);

      const indexMsg = messages.find((m) => m._entryId === 'index-entry-1');
      const searchMsg = messages.find((m) => m._entryId === 'search-entry-1');

      expect(indexMsg?._streamKey).toBe(INDEX_STREAM);
      expect(searchMsg?._streamKey).toBe(SEARCH_STREAM);

      // Cross-contamination check
      expect(indexMsg?._streamKey).not.toBe(SEARCH_STREAM);
      expect(searchMsg?._streamKey).not.toBe(INDEX_STREAM);
    });

    it('should return an empty array when both streams return null', async () => {
      mockXreadgroup.mockResolvedValue(null);

      const messages = await readFromStream('test-group', 'consumer-1', 10);
      expect(messages).toEqual([]);
    });

    it('should skip messages with missing required fields', async () => {
      // Provide an entry missing 'payload' field
      const incompleteEntry = [
        [INDEX_STREAM, [['3-0', ['id', 'msg-3', 'type', 'index-job', 'timestamp', '12345']]]],
      ];
      mockXreadgroup.mockResolvedValueOnce(incompleteEntry).mockResolvedValueOnce(null);

      const messages = await readFromStream('test-group', 'consumer-1', 10);
      expect(messages).toEqual([]);
    });

    it('should preserve _entryId exactly as returned by xreadgroup', async () => {
      const entryId = '1680000000000-0';
      mockXreadgroup
        .mockResolvedValueOnce(makeIndexEntry(entryId, 'tool-preserve'))
        .mockResolvedValueOnce(null);

      const messages = await readFromStream('test-group', 'consumer-1', 10);
      expect(messages[0]?._entryId).toBe(entryId);
    });

    it('should parse the payload field as JSON', async () => {
      mockXreadgroup
        .mockResolvedValueOnce(makeIndexEntry('5-0', 'tool-json'))
        .mockResolvedValueOnce(null);

      const messages = await readFromStream('test-group', 'consumer-1', 10);
      const payload = messages[0]?.payload as { toolId: string; priority: number };
      expect(payload.toolId).toBe('tool-json');
      expect(payload.priority).toBe(1);
    });
  });
});
