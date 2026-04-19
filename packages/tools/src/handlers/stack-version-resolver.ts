import { satisfies } from '@toolcairn/graph';
import type { StackEdgeRow, StackVersionInfo, StackVersionRow } from '@toolcairn/graph';

type RangeSystem = 'semver' | 'pep440' | 'maven' | 'composer' | 'ruby' | 'cargo' | 'opaque';

export type StackCompatStatus = 'compatible' | 'conflicts' | 'partial' | 'unknown';

export interface ResolvedToolVersion {
  tool: string;
  /**
   * Version we recommend using given the other tools in the stack. Falls back
   * to `latest_version` when no peer constraints target this tool, or when no
   * historic version satisfies every incoming constraint.
   */
  recommended_version: string | null;
  /** The is_latest-flagged version from the graph. */
  latest_version: string | null;
  registry: string | null;
  release_date: string | null;
  /**
   * Per-tool status rollup:
   *   compatible — all incoming constraints satisfied by the picked version
   *   conflicts  — at least one incoming constraint cannot be satisfied by any version
   *   partial    — picked version differs from latest (we downgraded to fit)
   *   unknown    — no version data OR no incoming constraints to verify against
   */
  status: StackCompatStatus;
}

export interface StackCompatRow {
  from_tool: string;
  from_version: string;
  to_tool: string;
  to_version: string | null;
  range: string;
  range_system: RangeSystem;
  kind: string | null;
  edge_type: StackEdgeRow['edge_type'];
  source: string;
  status: 'compatible' | 'conflicts' | 'unknown';
  reason?: string;
}

export interface StackResolution {
  resolved: ResolvedToolVersion[];
  compatibility_matrix: StackCompatRow[];
  stack_compatibility: StackCompatStatus;
}

/**
 * Resolve the most "coherent" version choice per tool in the stack.
 *
 * Algorithm:
 *   1. Seed each tool with its latest VersionNode (is_latest=true).
 *   2. Group edges by target tool — each group is the set of incoming peer
 *      constraints for that target.
 *   3. For each target with ≥1 peer constraint:
 *        - Try the currently-chosen version
 *        - If it fails, walk newer→older historic versions and pick the first
 *          that satisfies every required (non-optional) constraint
 *        - If nothing satisfies, keep the latest and flag 'conflicts'
 *   4. Build the compatibility matrix by re-evaluating each edge against the
 *      FINAL chosen versions (so signals reflect the resolved stack).
 *   5. Overall status:
 *        - all edges compatible → 'compatible'
 *        - any edge conflicts   → 'conflicts'
 *        - some tools had to downgrade → 'partial'
 *        - no edges at all      → 'unknown'
 *
 * Limitations (intentional MVP simplifications):
 *   - Only edges from is_latest versions are considered. If tool A gets
 *     downgraded, we don't re-query A's peer constraints for its chosen
 *     version — assumes peer ranges are stable across close minors.
 *   - Optional peers (`kind: 'optional_peer'`) are NOT constraints — a
 *     mismatch marks the matrix row as 'conflicts' but doesn't force a
 *     downgrade of the target tool.
 *   - Runtime edges (REQUIRES_RUNTIME) are included in the matrix for
 *     observability but cannot be "satisfied" here because runtimes have
 *     no VersionNode — their rows carry status 'unknown' unless the user
 *     supplies a concrete runtime version elsewhere.
 */
export function resolveStackVersions(
  info: StackVersionInfo,
  stackToolNames: string[],
): StackResolution {
  const { versions, edges } = info;
  const nameSet = new Set(stackToolNames);

  // Index versions by tool, sorted newest-first (latest flag wins, then release_date).
  const versionsByTool = new Map<string, StackVersionRow[]>();
  for (const row of versions) {
    if (!nameSet.has(row.tool)) continue;
    const list = versionsByTool.get(row.tool);
    if (list) list.push(row);
    else versionsByTool.set(row.tool, [row]);
  }
  for (const list of versionsByTool.values()) {
    list.sort((a, b) => {
      if (a.is_latest !== b.is_latest) return a.is_latest ? -1 : 1;
      const ra = a.release_date ? Date.parse(a.release_date) : 0;
      const rb = b.release_date ? Date.parse(b.release_date) : 0;
      return rb - ra;
    });
  }

  // Seed each tool with latest.
  const pickedVersion = new Map<string, StackVersionRow | null>();
  for (const tool of stackToolNames) {
    const list = versionsByTool.get(tool) ?? [];
    pickedVersion.set(tool, list.find((v) => v.is_latest) ?? list[0] ?? null);
  }

  // Group incoming peer constraints by target. Runtime edges don't force
  // version selection (target has no VersionNode) — tracked separately.
  const incomingPeers = new Map<string, StackEdgeRow[]>();
  for (const edge of edges) {
    if (!nameSet.has(edge.from_tool) || !nameSet.has(edge.to_tool)) continue;
    if (edge.edge_type !== 'VERSION_COMPATIBLE_WITH') continue;
    if (edge.kind === 'optional_peer') continue;
    const list = incomingPeers.get(edge.to_tool);
    if (list) list.push(edge);
    else incomingPeers.set(edge.to_tool, [edge]);
  }

  // For each tool with incoming hard peer constraints, pick the newest
  // version that satisfies every constraint.
  const downgraded = new Set<string>();
  for (const [target, constraints] of incomingPeers.entries()) {
    const candidates = versionsByTool.get(target) ?? [];
    if (!candidates.length) continue;
    let picked: StackVersionRow | null = null;
    for (const candidate of candidates) {
      if (!candidate.version) continue;
      const candVer = candidate.version;
      const ok = constraints.every((c) => {
        const result = satisfies(candVer, c.range, c.range_system as RangeSystem);
        return result.ok;
      });
      if (ok) {
        picked = candidate;
        break;
      }
    }
    if (picked) {
      const latest = pickedVersion.get(target);
      if (latest && picked.version !== latest.version) downgraded.add(target);
      pickedVersion.set(target, picked);
    }
    // If nothing satisfies, leave latest in place — matrix step will flag
    // the offending rows as conflicts.
  }

  // Build the compat matrix against the FINAL picks.
  const matrix: StackCompatRow[] = [];
  for (const edge of edges) {
    if (!nameSet.has(edge.from_tool) || !nameSet.has(edge.to_tool)) continue;
    const toPick = pickedVersion.get(edge.to_tool);
    const fromPick = pickedVersion.get(edge.from_tool);
    // Edges emitted by latest-version from the graph query — we use the
    // current pick's version in the matrix row to keep it consistent.
    const fromVersion = fromPick?.version ?? edge.from_version;
    const toVersion = toPick?.version ?? null;

    let status: StackCompatRow['status'] = 'unknown';
    let reason: string | undefined;
    if (edge.edge_type === 'REQUIRES_RUNTIME') {
      // Runtime targets have no VersionNode → cannot satisfy-check concretely.
      status = 'unknown';
      reason = 'runtime target has no VersionNode';
    } else if (toVersion) {
      const result = satisfies(toVersion, edge.range, edge.range_system as RangeSystem);
      if (result.ok) status = 'compatible';
      else if (edge.kind === 'optional_peer') {
        status = 'unknown';
        reason = result.reason;
      } else {
        status = 'conflicts';
        reason = result.reason;
      }
    }

    matrix.push({
      from_tool: edge.from_tool,
      from_version: fromVersion,
      to_tool: edge.to_tool,
      to_version: toVersion,
      range: edge.range,
      range_system: edge.range_system as RangeSystem,
      kind: edge.kind,
      edge_type: edge.edge_type,
      source: edge.source,
      status,
      ...(reason ? { reason } : {}),
    });
  }

  // Per-tool status rollup
  const incomingByTool = new Map<string, StackCompatRow[]>();
  for (const row of matrix) {
    const list = incomingByTool.get(row.to_tool);
    if (list) list.push(row);
    else incomingByTool.set(row.to_tool, [row]);
  }

  const resolved: ResolvedToolVersion[] = stackToolNames.map((tool) => {
    const pick = pickedVersion.get(tool) ?? null;
    const latest = (versionsByTool.get(tool) ?? []).find((v) => v.is_latest) ?? null;
    const rows = incomingByTool.get(tool) ?? [];
    let status: StackCompatStatus;
    if (!pick) status = 'unknown';
    else if (rows.some((r) => r.status === 'conflicts')) status = 'conflicts';
    else if (downgraded.has(tool)) status = 'partial';
    else if (rows.length === 0) status = 'unknown';
    else status = 'compatible';
    return {
      tool,
      recommended_version: pick?.version ?? null,
      latest_version: latest?.version ?? null,
      registry: pick?.registry ?? latest?.registry ?? null,
      release_date: pick?.release_date ?? latest?.release_date ?? null,
      status,
    };
  });

  // Overall
  let overall: StackCompatStatus;
  if (matrix.length === 0) {
    overall = 'unknown';
  } else if (matrix.some((r) => r.status === 'conflicts')) {
    overall = downgraded.size > 0 ? 'partial' : 'conflicts';
  } else if (downgraded.size > 0) {
    overall = 'partial';
  } else if (matrix.some((r) => r.status === 'compatible')) {
    overall = 'compatible';
  } else {
    overall = 'unknown';
  }

  return { resolved, compatibility_matrix: matrix, stack_compatibility: overall };
}
