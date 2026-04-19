import type { PeerConstraint, VersionMetadata } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import type { VersionExtractorContext } from './index.js';

const logger = createLogger({ name: '@toolcairn/indexer:rubygems-extractor' });

interface RubyGemsResponse {
  name?: string;
  version?: string;
  version_created_at?: string;
  yanked?: boolean;
  dependencies?: {
    runtime?: Array<{ name: string; requirements: string }>;
    development?: Array<{ name: string; requirements: string }>;
  };
}

interface RubyGemsVersionRow {
  number?: string;
  created_at?: string;
  yanked?: boolean;
  dependencies?: {
    runtime?: Array<{ name: string; requirements: string }>;
    development?: Array<{ name: string; requirements: string }>;
  };
}

function toPeers(
  deps: RubyGemsResponse['dependencies'] | RubyGemsVersionRow['dependencies'],
): PeerConstraint[] {
  const peers: PeerConstraint[] = [];
  for (const dep of deps?.runtime ?? []) {
    if (!dep?.name || !dep.requirements) continue;
    peers.push({
      packageName: dep.name,
      range: dep.requirements,
      rangeSystem: 'ruby',
      kind: 'peer',
    });
  }
  for (const dep of deps?.development ?? []) {
    if (!dep?.name || !dep.requirements) continue;
    peers.push({
      packageName: dep.name,
      range: dep.requirements,
      rangeSystem: 'ruby',
      kind: 'optional_peer',
    });
  }
  return peers;
}

/**
 * RubyGems — the primary /gems/{pkg}.json only returns the latest version's
 * manifest. To get historic versions with their declared dependencies we fetch
 * /versions/{pkg}.json (a flat array of every version with inline deps).
 *
 * The extra fetch is bounded (~1 extra call per rubygems tool). Falls back to
 * latest-only if the /versions endpoint fails or returns nothing.
 */
export async function extractRubyGems(ctx: VersionExtractorContext): Promise<VersionMetadata[]> {
  const raw = ctx.raw as RubyGemsResponse | null;
  if (!raw) return [];
  const latest = typeof raw.version === 'string' ? raw.version : '';
  if (!latest) return [];

  const latestMeta: VersionMetadata = {
    registry: 'rubygems',
    packageName: ctx.packageName,
    version: latest,
    releaseDate: raw.version_created_at ?? '',
    isStable: !/[a-z]/i.test(latest.replace(/\./g, '')),
    deprecated: raw.yanked === true,
    source: 'declared_dependency',
    peers: toPeers(raw.dependencies),
    engines: [],
  };

  // Fetch historic versions list. Non-fatal — 404 / timeout returns [].
  const historicRows = await fetchHistoricVersions(ctx.packageName);
  const historic: VersionMetadata[] = historicRows
    .filter((row) => typeof row.number === 'string' && row.number !== latest)
    .map((row) => ({
      registry: 'rubygems',
      packageName: ctx.packageName,
      version: row.number as string,
      releaseDate: row.created_at ?? '',
      isStable: !/[a-z]/i.test((row.number as string).replace(/\./g, '')),
      deprecated: row.yanked === true,
      // Historic rows include their own dependencies — promote to declared.
      source: 'declared_dependency',
      peers: toPeers(row.dependencies),
      engines: [],
    }));

  return [latestMeta, ...historic];
}

async function fetchHistoricVersions(packageName: string): Promise<RubyGemsVersionRow[]> {
  const url = `https://rubygems.org/api/v1/versions/${encodeURIComponent(packageName)}.json`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'toolcairn-indexer' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as RubyGemsVersionRow[];
    if (!Array.isArray(data)) return [];
    return data.sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : 0;
      const tb = b.created_at ? Date.parse(b.created_at) : 0;
      return tb - ta;
    });
  } catch (e) {
    logger.debug({ err: e, url }, 'rubygems historic versions fetch failed');
    return [];
  }
}
