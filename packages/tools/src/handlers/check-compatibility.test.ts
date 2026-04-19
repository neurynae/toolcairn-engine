import type { DirectEdge, RuntimeConstraintRow, VersionCompatibilityRow } from '@toolcairn/graph';
import { describe, expect, it } from 'vitest';
import { createCheckCompatibilityHandler } from './check-compatibility.js';

type OkResult<T> = { ok: true; data: T };
type ErrResult = { ok: false; error: string; message: string };

function ok<T>(data: T): OkResult<T> {
  return { ok: true, data };
}

/**
 * Unwrap MCP wire format:
 * { content: [{ type: 'text', text: JSON.stringify({ ok, data | error }) }] }
 */
function unwrap<T>(res: unknown): OkResult<T> | ErrResult {
  const content = (res as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.[0]?.text ?? '{"ok":false,"error":"no_content","message":""}';
  return JSON.parse(text) as OkResult<T> | ErrResult;
}

interface StubConfig {
  exists?: Record<string, boolean>;
  versionRow?: VersionCompatibilityRow | null;
  directEdges?: DirectEdge[];
  runtimes?: Record<string, RuntimeConstraintRow[]>;
}

function buildStubRepo(cfg: StubConfig) {
  const exists = cfg.exists ?? {};
  const versionRow = cfg.versionRow !== undefined ? cfg.versionRow : null;
  const directEdges = cfg.directEdges ?? [];
  const runtimes = cfg.runtimes ?? {};

  return {
    toolExists: async (name: string) => ok(exists[name] ?? true),
    getVersionCompatibilityBetween: async () => ok(versionRow),
    getDirectEdges: async () => ok(directEdges),
    getRuntimeConstraints: async (toolName: string) => ok(runtimes[toolName] ?? []),
    getRelated: async () => ok([] as Array<{ name: string }>),
    findByName: async (name: string) =>
      ok(exists[name] === false ? null : ({ name } as { name: string })),
    getAllToolNames: async () => ok(Object.keys(exists)),
  } as unknown as Parameters<typeof createCheckCompatibilityHandler>[0]['graphRepo'];
}

describe('check_compatibility handler', () => {
  describe('version-aware path', () => {
    it('returns compatible when declared peer range is satisfied', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({
          versionRow: {
            version_a: '15.0.3',
            version_b: '18.3.1',
            registry_a: 'npm',
            registry_b: 'npm',
            a_to_b: {
              range: '^18 || ^19',
              range_system: 'semver',
              kind: 'peer',
              source: 'declared_dependency',
            },
            b_to_a: null,
            a_runtime_b: null,
            b_runtime_a: null,
          },
        }),
      });
      const raw = await handler({ tool_a: 'next', tool_b: 'react' });
      const res = unwrap<{
        status: string;
        source: string;
        confidence: number;
        version_checks?: Array<{ satisfied: boolean }>;
      }>(raw);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.status).toBe('compatible');
        expect(res.data.source).toBe('declared_dependency');
        expect(res.data.version_checks?.[0]?.satisfied).toBe(true);
        expect(res.data.confidence).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('returns conflicts when declared peer range is violated', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({
          versionRow: {
            version_a: '15.0.3',
            version_b: '17.0.2',
            registry_a: 'npm',
            registry_b: 'npm',
            a_to_b: {
              range: '^18 || ^19',
              range_system: 'semver',
              kind: 'peer',
              source: 'declared_dependency',
            },
            b_to_a: null,
            a_runtime_b: null,
            b_runtime_a: null,
          },
        }),
      });
      const raw = await handler({ tool_a: 'next', tool_b: 'react' });
      const res = unwrap<{ status: string; source: string }>(raw);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.status).toBe('conflicts');
        expect(res.data.source).toBe('declared_dependency');
      }
    });

    it('returns unknown for optional peer mismatch (not conflicts)', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({
          versionRow: {
            version_a: '1.0.0',
            version_b: '0.5.0',
            registry_a: 'npm',
            registry_b: 'npm',
            a_to_b: {
              range: '^1.0.0',
              range_system: 'semver',
              kind: 'optional_peer',
              source: 'declared_dependency',
            },
            b_to_a: null,
            a_runtime_b: null,
            b_runtime_a: null,
          },
        }),
      });
      const raw = await handler({ tool_a: 'a', tool_b: 'b' });
      const res = unwrap<{ status: string }>(raw);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.status).toBe('unknown');
    });

    it('fires version-path on runtime edge alone (no peer edges)', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({
          versionRow: {
            version_a: '5.6.2',
            version_b: null,
            registry_a: 'npm',
            registry_b: null,
            a_to_b: null,
            b_to_a: null,
            a_runtime_b: {
              range: '>=20.9.0',
              range_system: 'semver',
              source: 'declared_dependency',
            },
            b_runtime_a: null,
          },
          runtimes: {
            typescript: [
              {
                version: '5.6.2',
                runtime: 'node',
                range: '>=20.9.0',
                range_system: 'semver',
                source: 'declared_dependency',
              },
            ],
          },
        }),
      });
      const raw = await handler({ tool_a: 'typescript', tool_b: 'node' });
      const res = unwrap<{
        status: string;
        source: string;
        runtime_requirements: Array<{ runtime: string; range: string }>;
        signals: string[];
      }>(raw);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.source).toBe('declared_dependency');
        expect(res.data.status).toBe('requires');
        expect(res.data.runtime_requirements[0]?.runtime).toBe('node');
        expect(res.data.signals.join(' ')).toMatch(/requires runtime node/);
      }
    });

    it('includes runtime requirements when present', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({
          versionRow: {
            version_a: '5.1.0',
            version_b: '0.5.0',
            registry_a: 'pypi',
            registry_b: 'pypi',
            a_to_b: {
              range: '>=0.4',
              range_system: 'pep440',
              kind: 'dep',
              source: 'declared_dependency',
            },
            b_to_a: null,
            a_runtime_b: null,
            b_runtime_a: null,
          },
          runtimes: {
            django: [
              {
                version: '5.1.0',
                runtime: 'python',
                range: '>=3.10',
                range_system: 'pep440',
                source: 'declared_dependency',
              },
            ],
          },
        }),
      });
      const raw = await handler({ tool_a: 'django', tool_b: 'asgiref' });
      const res = unwrap<{
        runtime_requirements: Array<{ runtime: string; range: string }>;
      }>(raw);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.runtime_requirements).toHaveLength(1);
        expect(res.data.runtime_requirements[0]?.runtime).toBe('python');
      }
    });
  });

  describe('legacy fallback', () => {
    it('falls through to graph edges when no version row', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({
          versionRow: null,
          directEdges: [
            {
              edgeType: 'COMPATIBLE_WITH',
              weight: 0.8,
              effective_weight: 0.8,
              confidence: 0.9,
              direction: 'a_to_b',
            },
          ],
        }),
      });
      const raw = await handler({ tool_a: 'a', tool_b: 'b' });
      const res = unwrap<{
        status: string;
        source: string;
        direct_edges: Array<{ type: string }>;
      }>(raw);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.status).toBe('compatible');
        expect(res.data.source).toBe('graph_edges');
        expect(res.data.direct_edges[0]?.type).toBe('COMPATIBLE_WITH');
      }
    });

    it('falls through to shared neighbors when no edges and no versions', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({ versionRow: null, directEdges: [] }),
      });
      const raw = await handler({ tool_a: 'a', tool_b: 'b' });
      const res = unwrap<{ source: string }>(raw);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.source).toBe('shared_neighbors');
    });

    it('falls through when version row has no range on either direction', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({
          versionRow: {
            version_a: '1.0.0',
            version_b: '2.0.0',
            registry_a: 'npm',
            registry_b: 'npm',
            a_to_b: null,
            b_to_a: null,
            a_runtime_b: null,
            b_runtime_a: null,
          },
          directEdges: [],
        }),
      });
      const raw = await handler({ tool_a: 'a', tool_b: 'b' });
      const res = unwrap<{ source: string }>(raw);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.source).toBe('shared_neighbors');
    });
  });

  describe('not-found', () => {
    it('returns tool_not_found when tool_a does not exist', async () => {
      const handler = createCheckCompatibilityHandler({
        graphRepo: buildStubRepo({ exists: { a: false, b: true } }),
      });
      const raw = await handler({ tool_a: 'a', tool_b: 'b' });
      const res = unwrap<unknown>(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('tool_not_found');
    });
  });
});
