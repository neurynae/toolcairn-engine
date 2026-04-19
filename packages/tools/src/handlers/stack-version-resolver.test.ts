import type { StackEdgeRow, StackVersionInfo, StackVersionRow } from '@toolcairn/graph';
import { describe, expect, it } from 'vitest';
import { resolveStackVersions } from './stack-version-resolver.js';

function v(
  tool: string,
  version: string,
  opts: { isLatest?: boolean; registry?: string; released?: string } = {},
): StackVersionRow {
  return {
    tool,
    version,
    registry: opts.registry ?? 'npm',
    release_date: opts.released ?? '',
    is_stable: true,
    is_latest: opts.isLatest ?? false,
  };
}

function peer(
  from: string,
  fromVersion: string,
  to: string,
  range: string,
  opts: { kind?: string; system?: string } = {},
): StackEdgeRow {
  return {
    from_tool: from,
    from_version: fromVersion,
    from_registry: 'npm',
    to_tool: to,
    edge_type: 'VERSION_COMPATIBLE_WITH',
    range,
    range_system: opts.system ?? 'semver',
    kind: opts.kind ?? 'peer',
    source: 'declared_dependency',
  };
}

function runtime(
  from: string,
  fromVersion: string,
  to: string,
  range: string,
  system = 'semver',
): StackEdgeRow {
  return {
    from_tool: from,
    from_version: fromVersion,
    from_registry: 'npm',
    to_tool: to,
    edge_type: 'REQUIRES_RUNTIME',
    range,
    range_system: system,
    kind: null,
    source: 'declared_dependency',
  };
}

describe('resolveStackVersions', () => {
  it('returns compatible when all peer constraints hold at latest', () => {
    const info: StackVersionInfo = {
      versions: [v('next', '15.0.3', { isLatest: true }), v('react', '19.2.5', { isLatest: true })],
      edges: [peer('next', '15.0.3', 'react', '^18 || ^19')],
    };
    const { resolved, compatibility_matrix, stack_compatibility } = resolveStackVersions(info, [
      'next',
      'react',
    ]);
    expect(stack_compatibility).toBe('compatible');
    expect(compatibility_matrix[0]?.status).toBe('compatible');
    expect(resolved.find((r) => r.tool === 'next')?.recommended_version).toBe('15.0.3');
    expect(resolved.find((r) => r.tool === 'react')?.recommended_version).toBe('19.2.5');
    expect(resolved.find((r) => r.tool === 'react')?.status).toBe('compatible');
  });

  it('downgrades target to satisfy incoming peer constraint', () => {
    const info: StackVersionInfo = {
      versions: [
        v('next', '15.0.3', { isLatest: true }),
        v('react', '19.2.5', { isLatest: true, released: '2025-01-01' }),
        v('react', '17.0.2', { released: '2023-01-01' }),
      ],
      edges: [peer('next', '15.0.3', 'react', '^17')],
    };
    const { resolved, compatibility_matrix, stack_compatibility } = resolveStackVersions(info, [
      'next',
      'react',
    ]);
    const react = resolved.find((r) => r.tool === 'react');
    expect(react?.recommended_version).toBe('17.0.2');
    expect(react?.latest_version).toBe('19.2.5');
    expect(react?.status).toBe('partial');
    expect(stack_compatibility).toBe('partial');
    expect(compatibility_matrix[0]?.status).toBe('compatible');
    expect(compatibility_matrix[0]?.to_version).toBe('17.0.2');
  });

  it('flags conflicts when no version satisfies the required peer', () => {
    const info: StackVersionInfo = {
      versions: [v('next', '15.0.3', { isLatest: true }), v('react', '19.2.5', { isLatest: true })],
      edges: [peer('next', '15.0.3', 'react', '^20')],
    };
    const { resolved, stack_compatibility, compatibility_matrix } = resolveStackVersions(info, [
      'next',
      'react',
    ]);
    expect(stack_compatibility).toBe('conflicts');
    expect(compatibility_matrix[0]?.status).toBe('conflicts');
    expect(resolved.find((r) => r.tool === 'react')?.status).toBe('conflicts');
  });

  it('treats optional_peer mismatch as unknown, not conflicts', () => {
    const info: StackVersionInfo = {
      versions: [v('next', '15.0.3', { isLatest: true }), v('sass', '0.5.0', { isLatest: true })],
      edges: [peer('next', '15.0.3', 'sass', '^1.3.0', { kind: 'optional_peer' })],
    };
    const { stack_compatibility, compatibility_matrix } = resolveStackVersions(info, [
      'next',
      'sass',
    ]);
    // Optional peer mismatch -> row.status == 'unknown', overall stays compatible-or-unknown
    expect(compatibility_matrix[0]?.status).toBe('unknown');
    expect(stack_compatibility).not.toBe('conflicts');
  });

  it('includes REQUIRES_RUNTIME edges in the matrix with status "unknown"', () => {
    const info: StackVersionInfo = {
      versions: [v('typescript', '5.6.2', { isLatest: true })],
      edges: [runtime('typescript', '5.6.2', 'node', '>=20.9.0')],
    };
    const { compatibility_matrix, resolved } = resolveStackVersions(info, ['typescript', 'node']);
    expect(compatibility_matrix[0]?.edge_type).toBe('REQUIRES_RUNTIME');
    expect(compatibility_matrix[0]?.status).toBe('unknown');
    expect(resolved.find((r) => r.tool === 'typescript')?.recommended_version).toBe('5.6.2');
  });

  it('returns unknown stack status when no edges exist', () => {
    const info: StackVersionInfo = {
      versions: [v('a', '1.0.0', { isLatest: true }), v('b', '2.0.0', { isLatest: true })],
      edges: [],
    };
    const { stack_compatibility, compatibility_matrix } = resolveStackVersions(info, ['a', 'b']);
    expect(compatibility_matrix).toEqual([]);
    expect(stack_compatibility).toBe('unknown');
  });

  it('tolerates missing VersionNodes — falls back to null recommendations', () => {
    const info: StackVersionInfo = {
      versions: [v('next', '15.0.3', { isLatest: true })],
      edges: [peer('next', '15.0.3', 'react', '^18 || ^19')],
    };
    const { resolved } = resolveStackVersions(info, ['next', 'react']);
    const react = resolved.find((r) => r.tool === 'react');
    expect(react?.recommended_version).toBeNull();
    expect(react?.status).toBe('unknown');
  });
});
