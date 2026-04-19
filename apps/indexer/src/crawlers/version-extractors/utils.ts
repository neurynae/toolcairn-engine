import type { PeerConstraint } from '@toolcairn/core';

/** Deterministic Version id: "ver:{registry}:{pkg}:{version}". */
export function buildVersionId(registry: string, packageName: string, version: string): string {
  const normalized = version.trim().replace(/^v/, '');
  return `ver:${registry}:${packageName.toLowerCase()}:${normalized}`;
}

/** Walk a plain object / dict into PeerConstraint[]. Filters empty values. */
export function dictToPeers(
  dict: Record<string, string> | undefined,
  rangeSystem: PeerConstraint['rangeSystem'],
  kind: PeerConstraint['kind'] = 'peer',
): PeerConstraint[] {
  if (!dict || typeof dict !== 'object') return [];
  const out: PeerConstraint[] = [];
  for (const [packageName, range] of Object.entries(dict)) {
    if (!packageName || typeof range !== 'string' || !range.trim()) continue;
    out.push({ packageName, range: range.trim(), rangeSystem, kind });
  }
  return out;
}
