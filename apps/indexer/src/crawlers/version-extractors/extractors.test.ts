import { describe, expect, it } from 'vitest';
import { extractCrates } from './crates.extractor.js';
import { extractHex } from './hex.extractor.js';
import { extractNpm } from './npm.extractor.js';
import { extractPackagist } from './packagist.extractor.js';
import { extractPub } from './pub.extractor.js';
import { extractPyPI } from './pypi.extractor.js';
import { buildVersionId } from './utils.js';
import { extractVersionOnly } from './version-only.extractor.js';

describe('buildVersionId', () => {
  it('produces deterministic id with normalized version', () => {
    expect(buildVersionId('npm', 'next', '15.0.3')).toBe('ver:npm:next:15.0.3');
    expect(buildVersionId('npm', 'Next', 'v15.0.3')).toBe('ver:npm:next:15.0.3');
  });
});

describe('extractNpm', () => {
  it('handles legacy /latest single-version response shape', async () => {
    const raw = {
      name: 'next',
      version: '15.0.3',
      peerDependencies: { react: '^18 || ^19', 'react-dom': '^18 || ^19' },
      peerDependenciesMeta: { 'react-dom': { optional: false }, sass: { optional: true } },
      engines: { node: '>=18.17.0' },
    };
    const metas = await extractNpm({ registry: 'npm', packageName: 'next', raw });
    expect(metas).toHaveLength(1);
    const m = metas[0];
    expect(m?.version).toBe('15.0.3');
    expect(m?.peers).toHaveLength(2);
    expect(m?.peers.find((p) => p.packageName === 'react')?.range).toBe('^18 || ^19');
    expect(m?.engines[0]).toEqual({ runtime: 'node', range: '>=18.17.0', rangeSystem: 'semver' });
    expect(m?.source).toBe('declared_dependency');
  });

  it('handles packument shape with versions map + dist-tags', async () => {
    const raw = {
      name: 'next',
      'dist-tags': { latest: '15.0.3' },
      time: {
        '14.0.0': '2024-01-01T00:00:00Z',
        '15.0.0': '2024-10-01T00:00:00Z',
        '15.0.3': '2024-11-06T00:00:00Z',
      },
      versions: {
        '14.0.0': {
          version: '14.0.0',
          peerDependencies: { react: '^18' },
          engines: { node: '>=16.14.0' },
        },
        '15.0.0': {
          version: '15.0.0',
          peerDependencies: { react: '^18 || ^19' },
          engines: { node: '>=18.17.0' },
        },
        '15.0.3': {
          version: '15.0.3',
          peerDependencies: { react: '^18 || ^19' },
          engines: { node: '>=18.17.0' },
        },
      },
    };
    const metas = await extractNpm({ registry: 'npm', packageName: 'next', raw });
    expect(metas).toHaveLength(3);
    // Latest tag is pinned to index 0
    expect(metas[0]?.version).toBe('15.0.3');
    // Historic versions preserved with their own peers
    expect(metas.find((m) => m.version === '14.0.0')?.peers[0]?.range).toBe('^18');
  });

  it('returns empty array when neither shape matches', async () => {
    const metas = await extractNpm({ registry: 'npm', packageName: 'x', raw: { name: 'x' } });
    expect(metas).toEqual([]);
  });

  it('marks optional peers correctly', async () => {
    const raw = {
      version: '1.0.0',
      peerDependencies: { react: '^18' },
      peerDependenciesMeta: { react: { optional: true } },
    };
    const metas = await extractNpm({ registry: 'npm', packageName: 'opt', raw });
    expect(metas[0]?.peers[0]?.kind).toBe('optional_peer');
  });
});

describe('extractPyPI', () => {
  it('extracts latest requires_python + requires_dist and preserves historic versions', () => {
    const raw = {
      info: {
        name: 'django',
        version: '5.1.0',
        requires_python: '>=3.10',
        requires_dist: ['asgiref (>=3.8.1,<4)', 'sqlparse (>=0.3.1)'],
      },
      releases: {
        '5.1.0': [{ upload_time_iso_8601: '2024-08-07T00:00:00Z' }],
        '5.0.0': [{ upload_time_iso_8601: '2023-12-04T00:00:00Z' }],
        '4.2.0': [{ upload_time_iso_8601: '2023-04-03T00:00:00Z' }],
      },
    };
    const metas = extractPyPI({ registry: 'pypi', packageName: 'django', raw });
    expect(metas.length).toBeGreaterThanOrEqual(3);
    expect(metas[0]?.version).toBe('5.1.0');
    expect(metas[0]?.source).toBe('declared_dependency');
    expect(metas[0]?.engines[0]?.runtime).toBe('python');
    // Historic entries exist with version_only source and no deps
    const historic = metas.find((m) => m.version === '4.2.0');
    expect(historic?.source).toBe('version_only');
    expect(historic?.peers).toEqual([]);
  });

  it('drops environment markers but keeps main constraint', () => {
    const raw = {
      info: {
        version: '1.0.0',
        requires_dist: ["requests (>=2.0); python_version >= '3.8'"],
      },
    };
    const metas = extractPyPI({ registry: 'pypi', packageName: 'x', raw });
    expect(metas[0]?.peers[0]?.packageName).toBe('requests');
    expect(metas[0]?.peers[0]?.range).toBe('>=2.0');
  });
});

describe('extractCrates', () => {
  it('extracts rust-version as REQUIRES_RUNTIME on latest; historic as version_only', () => {
    const raw = {
      crate: { name: 'serde', max_stable_version: '1.0.200', updated_at: '2024-05-01T00:00:00Z' },
      versions: [
        { num: '1.0.200', rust_version: '1.56', yanked: false, created_at: '2024-05-01' },
        { num: '1.0.100', yanked: false, created_at: '2023-01-01' },
      ],
    };
    const metas = extractCrates({ registry: 'crates', packageName: 'serde', raw });
    expect(metas[0]?.version).toBe('1.0.200');
    expect(metas[0]?.engines[0]?.runtime).toBe('rust');
    expect(metas[1]?.source).toBe('version_only');
  });
});

describe('extractPackagist', () => {
  it('excludes php + ext-* from peers and moves php to engines', () => {
    const raw = {
      package: {
        name: 'symfony/console',
        versions: {
          '7.1.0': {
            time: '2024-05-30',
            require: {
              php: '>=8.2',
              'ext-json': '*',
              'symfony/polyfill-mbstring': '~1.0',
            },
          },
        },
      },
    };
    const metas = extractPackagist({
      registry: 'packagist',
      packageName: 'symfony/console',
      raw,
    });
    expect(metas[0]?.engines[0]?.runtime).toBe('php');
    expect(metas[0]?.peers.find((p) => p.packageName === 'php')).toBeUndefined();
    expect(metas[0]?.peers.find((p) => p.packageName === 'ext-json')).toBeUndefined();
    expect(metas[0]?.peers.find((p) => p.packageName === 'symfony/polyfill-mbstring')).toBeTruthy();
  });
});

describe('extractPub', () => {
  it('pulls dart sdk as engine', () => {
    const raw = {
      latest: {
        version: '3.0.0',
        published: '2024-01-01',
        pubspec: {
          dependencies: { http: '^1.0.0' },
          environment: { sdk: '>=3.0.0 <4.0.0' },
        },
      },
    };
    const metas = extractPub({ registry: 'pub', packageName: 'demo', raw });
    expect(metas[0]?.engines[0]?.runtime).toBe('dart');
    expect(metas[0]?.peers[0]?.packageName).toBe('http');
  });
});

describe('extractHex', () => {
  it('extracts requirements with optional flag on latest', () => {
    const raw = {
      latest_stable_version: '1.5.0',
      releases: [
        { version: '1.5.0', inserted_at: '2024-01-01T00:00:00Z' },
        { version: '1.4.0', inserted_at: '2023-06-01T00:00:00Z' },
      ],
      meta: {
        requirements: {
          plug: { optional: false, requirement: '~> 1.0' },
          jason: { optional: true, requirement: '~> 1.2' },
        },
      },
    };
    const metas = extractHex({ registry: 'hex', packageName: 'x', raw });
    expect(metas[0]?.version).toBe('1.5.0');
    expect(metas[0]?.peers.find((p) => p.packageName === 'plug')?.kind).toBe('peer');
    expect(metas[0]?.peers.find((p) => p.packageName === 'jason')?.kind).toBe('optional_peer');
    // Historic 1.4.0 exists but as version_only with no peers
    expect(metas.find((m) => m.version === '1.4.0')?.source).toBe('version_only');
  });
});

describe('extractVersionOnly', () => {
  it('finds version from probed field paths', () => {
    expect(
      extractVersionOnly({
        registry: 'docker',
        packageName: 'nginx',
        raw: { version: '1.25.0' },
      })[0]?.version,
    ).toBe('1.25.0');
    expect(
      extractVersionOnly({
        registry: 'flathub',
        packageName: 'x',
        raw: { latest: { version: '0.5.0' } },
      })[0]?.version,
    ).toBe('0.5.0');
  });

  it('returns empty array when no version field found', () => {
    expect(
      extractVersionOnly({ registry: 'docker', packageName: 'x', raw: { nothing: true } }),
    ).toEqual([]);
  });
});
