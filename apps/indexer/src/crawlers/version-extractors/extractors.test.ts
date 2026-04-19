import { describe, expect, it } from 'vitest';
import { extractCrates } from './crates.extractor.js';
import { extractHex } from './hex.extractor.js';
import { extractNpm } from './npm.extractor.js';
import { extractPackagist } from './packagist.extractor.js';
import { extractPub } from './pub.extractor.js';
import { extractPyPI } from './pypi.extractor.js';
import { extractRubyGems } from './rubygems.extractor.js';
import { buildVersionId } from './utils.js';
import { extractVersionOnly } from './version-only.extractor.js';

describe('buildVersionId', () => {
  it('produces deterministic id with normalized version', () => {
    expect(buildVersionId('npm', 'next', '15.0.3')).toBe('ver:npm:next:15.0.3');
    expect(buildVersionId('npm', 'Next', 'v15.0.3')).toBe('ver:npm:next:15.0.3');
  });
});

describe('extractNpm', () => {
  it('extracts peer deps + engines + tags optional peers', () => {
    const raw = {
      name: 'next',
      version: '15.0.3',
      peerDependencies: { react: '^18 || ^19', 'react-dom': '^18 || ^19' },
      peerDependenciesMeta: { 'react-dom': { optional: false }, sass: { optional: true } },
      engines: { node: '>=18.17.0' },
      time: { '15.0.3': '2024-11-06T00:00:00Z' },
    };
    const meta = extractNpm({ registry: 'npm', packageName: 'next', raw });
    expect(meta?.version).toBe('15.0.3');
    expect(meta?.peers).toHaveLength(2);
    expect(meta?.peers.find((p) => p.packageName === 'react')?.range).toBe('^18 || ^19');
    expect(meta?.engines[0]).toEqual({
      runtime: 'node',
      range: '>=18.17.0',
      rangeSystem: 'semver',
    });
    expect(meta?.source).toBe('declared_dependency');
  });

  it('returns null when version missing', () => {
    expect(extractNpm({ registry: 'npm', packageName: 'x', raw: { name: 'x' } })).toBeNull();
  });

  it('marks optional peers correctly', () => {
    const raw = {
      version: '1.0.0',
      peerDependencies: { react: '^18' },
      peerDependenciesMeta: { react: { optional: true } },
    };
    const meta = extractNpm({ registry: 'npm', packageName: 'opt', raw });
    expect(meta?.peers[0]?.kind).toBe('optional_peer');
  });
});

describe('extractPyPI', () => {
  it('extracts requires_python + requires_dist', () => {
    const raw = {
      info: {
        name: 'django',
        version: '5.1.0',
        requires_python: '>=3.10',
        requires_dist: ['asgiref (>=3.8.1,<4)', 'sqlparse (>=0.3.1)'],
      },
      releases: { '5.1.0': [{ upload_time_iso_8601: '2024-08-07T00:00:00Z' }] },
    };
    const meta = extractPyPI({ registry: 'pypi', packageName: 'django', raw });
    expect(meta?.version).toBe('5.1.0');
    expect(meta?.engines[0]?.runtime).toBe('python');
    expect(meta?.engines[0]?.range).toBe('>=3.10');
    expect(meta?.peers.length).toBeGreaterThanOrEqual(1);
    expect(meta?.peers.find((p) => p.packageName === 'asgiref')?.range).toBe('>=3.8.1,<4');
  });

  it('drops environment markers but keeps main constraint', () => {
    const raw = {
      info: {
        version: '1.0.0',
        requires_dist: ["requests (>=2.0); python_version >= '3.8'"],
      },
    };
    const meta = extractPyPI({ registry: 'pypi', packageName: 'x', raw });
    expect(meta?.peers[0]?.packageName).toBe('requests');
    expect(meta?.peers[0]?.range).toBe('>=2.0');
  });
});

describe('extractCrates', () => {
  it('extracts rust-version as REQUIRES_RUNTIME', () => {
    const raw = {
      crate: { name: 'serde', max_stable_version: '1.0.200', updated_at: '2024-05-01T00:00:00Z' },
      versions: [{ num: '1.0.200', rust_version: '1.56', yanked: false, created_at: '2024-05-01' }],
    };
    const meta = extractCrates({ registry: 'crates', packageName: 'serde', raw });
    expect(meta?.version).toBe('1.0.200');
    expect(meta?.engines[0]?.runtime).toBe('rust');
    expect(meta?.engines[0]?.range).toBe('>=1.56');
  });
});

describe('extractRubyGems', () => {
  it('splits runtime/development deps into kinds', () => {
    const raw = {
      version: '7.1.0',
      version_created_at: '2023-10-05',
      dependencies: {
        runtime: [{ name: 'actionpack', requirements: '= 7.1.0' }],
        development: [{ name: 'rspec', requirements: '~> 3.12' }],
      },
    };
    const meta = extractRubyGems({ registry: 'rubygems', packageName: 'rails', raw });
    expect(meta?.peers).toHaveLength(2);
    expect(meta?.peers.find((p) => p.packageName === 'actionpack')?.kind).toBe('peer');
    expect(meta?.peers.find((p) => p.packageName === 'rspec')?.kind).toBe('optional_peer');
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
    const meta = extractPackagist({
      registry: 'packagist',
      packageName: 'symfony/console',
      raw,
    });
    expect(meta?.engines[0]?.runtime).toBe('php');
    expect(meta?.peers.find((p) => p.packageName === 'php')).toBeUndefined();
    expect(meta?.peers.find((p) => p.packageName === 'ext-json')).toBeUndefined();
    expect(meta?.peers.find((p) => p.packageName === 'symfony/polyfill-mbstring')).toBeTruthy();
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
    const meta = extractPub({ registry: 'pub', packageName: 'demo', raw });
    expect(meta?.engines[0]?.runtime).toBe('dart');
    expect(meta?.peers[0]?.packageName).toBe('http');
  });
});

describe('extractHex', () => {
  it('extracts requirements with optional flag', () => {
    const raw = {
      latest_stable_version: '1.5.0',
      meta: {
        requirements: {
          plug: { optional: false, requirement: '~> 1.0' },
          jason: { optional: true, requirement: '~> 1.2' },
        },
      },
    };
    const meta = extractHex({ registry: 'hex', packageName: 'x', raw });
    expect(meta?.version).toBe('1.5.0');
    expect(meta?.peers.find((p) => p.packageName === 'plug')?.kind).toBe('peer');
    expect(meta?.peers.find((p) => p.packageName === 'jason')?.kind).toBe('optional_peer');
  });
});

describe('extractVersionOnly', () => {
  it('finds version from probed field paths', () => {
    expect(
      extractVersionOnly({ registry: 'docker', packageName: 'nginx', raw: { version: '1.25.0' } })
        ?.version,
    ).toBe('1.25.0');
    expect(
      extractVersionOnly({
        registry: 'flathub',
        packageName: 'x',
        raw: { latest: { version: '0.5.0' } },
      })?.version,
    ).toBe('0.5.0');
  });

  it('returns null when no version field found', () => {
    expect(
      extractVersionOnly({ registry: 'docker', packageName: 'x', raw: { nothing: true } }),
    ).toBeNull();
  });
});
