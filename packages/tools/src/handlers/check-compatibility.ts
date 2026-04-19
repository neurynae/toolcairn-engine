import { createLogger } from '@toolcairn/errors';
import { satisfies } from '@toolcairn/graph';
import type { VersionCompatibilityRow } from '@toolcairn/graph';
import type { ToolDeps } from '../types.js';
import { errResult, okResult, resolveToolName } from '../utils.js';

const logger = createLogger({ name: '@toolcairn/tools:check-compatibility' });

const COMPATIBLE_TYPES = new Set(['COMPATIBLE_WITH', 'INTEGRATES_WITH', 'POPULAR_WITH']);
const CONFLICT_TYPES = new Set(['CONFLICTS_WITH', 'BREAKS_FROM']);
const REQUIRES_TYPES = new Set(['REQUIRES']);

type CompatibilityStatus = 'compatible' | 'conflicts' | 'requires' | 'unknown';
type RangeSystem = 'semver' | 'pep440' | 'maven' | 'composer' | 'ruby' | 'cargo' | 'opaque';

interface VersionCheck {
  from: string;
  to: string;
  kind: string;
  range: string;
  range_system: RangeSystem;
  satisfied: boolean;
  reason?: string;
}

interface RuntimeRequirement {
  tool: string;
  runtime: string;
  range: string;
  range_system: RangeSystem;
  source: string;
  satisfied?: boolean;
}

/**
 * Version-aware compatibility evaluation.
 *
 * Flow:
 *   1. Resolve tool names + existence check (unchanged from prior behavior).
 *   2. Probe Memgraph for Version nodes on both sides. If either tool has no
 *      VersionNode, fall through to the legacy Tool↔Tool edge path.
 *   3. Evaluate declared peer ranges with the shared range-evaluator.
 *   4. Fetch runtime (REQUIRES_RUNTIME) edges and include them in the signals.
 *   5. Return enriched response + `source: "declared_dependency"`.
 *
 * Legacy fallback — `source: "graph_edges" | "shared_neighbors"` — fires when:
 *   - Neither tool has VersionNodes yet (registry Tier C or not-yet-indexed).
 *   - No VERSION_COMPATIBLE_WITH edges exist between them (declared peers
 *     haven't resolved because target Tool isn't in the graph).
 */
export function createCheckCompatibilityHandler(deps: Pick<ToolDeps, 'graphRepo'>) {
  return async function handleCheckCompatibility(args: {
    tool_a: string;
    tool_b: string;
    tool_a_version?: string;
    tool_b_version?: string;
  }) {
    try {
      logger.info(
        {
          tool_a: args.tool_a,
          tool_b: args.tool_b,
          tool_a_version: args.tool_a_version,
          tool_b_version: args.tool_b_version,
        },
        'check_compatibility called',
      );

      const [resolvedA, resolvedB] = await Promise.all([
        resolveToolName(args.tool_a, deps.graphRepo),
        resolveToolName(args.tool_b, deps.graphRepo),
      ]);

      const [existsA, existsB] = await Promise.all([
        deps.graphRepo.toolExists(resolvedA),
        deps.graphRepo.toolExists(resolvedB),
      ]);
      if (!existsA.ok || !existsA.data) {
        return errResult(
          'tool_not_found',
          `Tool "${args.tool_a}" not found in the ToolCairn index`,
        );
      }
      if (!existsB.ok || !existsB.data) {
        return errResult(
          'tool_not_found',
          `Tool "${args.tool_b}" not found in the ToolCairn index`,
        );
      }

      // ─── Version-aware path ────────────────────────────────────────────────
      const versionRows = await deps.graphRepo.getVersionCompatibilityBetween(
        resolvedA,
        resolvedB,
        args.tool_a_version,
        args.tool_b_version,
      );

      if (versionRows.ok && versionRows.data && shouldUseVersionPath(versionRows.data)) {
        const row = versionRows.data;
        const evaluation = evaluateVersionRow(row, resolvedA, resolvedB);

        const [runtimeA, runtimeB] = await Promise.all([
          deps.graphRepo.getRuntimeConstraints(resolvedA, row.version_a ?? undefined),
          deps.graphRepo.getRuntimeConstraints(resolvedB, row.version_b ?? undefined),
        ]);
        const runtime_requirements: RuntimeRequirement[] = [];
        if (runtimeA.ok) {
          for (const r of runtimeA.data) {
            runtime_requirements.push({
              tool: resolvedA,
              runtime: r.runtime,
              range: r.range,
              range_system: r.range_system as RangeSystem,
              source: r.source,
            });
          }
        }
        if (runtimeB.ok) {
          for (const r of runtimeB.data) {
            runtime_requirements.push({
              tool: resolvedB,
              runtime: r.runtime,
              range: r.range,
              range_system: r.range_system as RangeSystem,
              source: r.source,
            });
          }
        }

        return okResult({
          tool_a: resolvedA,
          tool_b: resolvedB,
          tool_a_version: row.version_a,
          tool_b_version: row.version_b,
          status: evaluation.status,
          confidence: Math.round(evaluation.confidence * 100) / 100,
          direct_edges: [],
          version_checks: evaluation.checks,
          runtime_requirements,
          signals: evaluation.signals,
          recommendation: buildRecommendation(
            resolvedA,
            resolvedB,
            row.version_a,
            row.version_b,
            evaluation.status,
          ),
          source: 'declared_dependency' as const,
          suggest_graph_update: null,
        });
      }

      // ─── Legacy fallback: direct Tool↔Tool edges + shared-neighbors ────────
      const edgesResult = await deps.graphRepo.getDirectEdges(resolvedA, resolvedB);
      if (!edgesResult.ok) {
        return errResult('graph_error', edgesResult.error.message);
      }
      const edges = edgesResult.data;
      let status: CompatibilityStatus = 'unknown';
      let confidence = 0.5;
      const signals: string[] = [];
      let fallbackSource: 'graph_edges' | 'shared_neighbors' = 'graph_edges';

      if (edges.length > 0) {
        confidence = Math.max(...edges.map((e) => e.confidence));
        if (edges.some((e) => CONFLICT_TYPES.has(e.edgeType))) {
          status = 'conflicts';
          signals.push(
            `Direct ${edges.find((e) => CONFLICT_TYPES.has(e.edgeType))?.edgeType} edge found`,
          );
        } else if (edges.some((e) => COMPATIBLE_TYPES.has(e.edgeType))) {
          status = 'compatible';
          signals.push(
            `Direct ${edges.find((e) => COMPATIBLE_TYPES.has(e.edgeType))?.edgeType} edge found`,
          );
        } else if (edges.some((e) => REQUIRES_TYPES.has(e.edgeType))) {
          status = 'requires';
          signals.push('Direct REQUIRES relationship found');
        }
      } else {
        fallbackSource = 'shared_neighbors';
        const [neighborsA, neighborsB] = await Promise.all([
          deps.graphRepo.getRelated(args.tool_a, 10),
          deps.graphRepo.getRelated(args.tool_b, 10),
        ]);
        if (neighborsA.ok && neighborsB.ok) {
          const namesA = new Set(neighborsA.data.map((t) => t.name));
          const namesB = new Set(neighborsB.data.map((t) => t.name));
          const sharedNeighbors = [...namesA].filter((n) => namesB.has(n));
          if (sharedNeighbors.length >= 3) {
            status = 'compatible';
            confidence = 0.6;
            signals.push(
              `${sharedNeighbors.length} shared graph neighbors suggest these tools are used together`,
            );
          } else if (sharedNeighbors.length > 0) {
            status = 'unknown';
            confidence = 0.4;
            signals.push(
              `${sharedNeighbors.length} shared neighbors found — insufficient for strong inference`,
            );
          } else {
            signals.push(
              'No direct edges or shared neighbors — these tools may operate in different domains',
            );
          }
        }
      }

      const recommendation =
        status === 'compatible'
          ? `${args.tool_a} and ${args.tool_b} can be used together.`
          : status === 'conflicts'
            ? `${args.tool_a} and ${args.tool_b} have known conflicts. Avoid using them in the same project.`
            : status === 'requires'
              ? 'One of these tools requires the other. Check the direction of the REQUIRES edge.'
              : 'No direct compatibility data. These tools may work together but it has not been verified.';

      return okResult({
        tool_a: resolvedA,
        tool_b: resolvedB,
        status,
        confidence: Math.round(confidence * 100) / 100,
        direct_edges: edges.map((e) => ({
          type: e.edgeType,
          direction: e.direction,
          confidence: Math.round(e.confidence * 100) / 100,
          effective_weight: Math.round(e.effective_weight * 100) / 100,
        })),
        signals,
        recommendation,
        source: fallbackSource,
        suggest_graph_update:
          status === 'unknown'
            ? 'If you discover compatibility data, call suggest_graph_update with suggestion_type: "new_edge" to contribute it back.'
            : null,
      });
    } catch (e) {
      logger.error({ err: e }, 'check_compatibility failed');
      return errResult('compatibility_error', e instanceof Error ? e.message : String(e));
    }
  };
}

/** Only take the version path if at least one direction carries a declared range. */
function shouldUseVersionPath(row: VersionCompatibilityRow): boolean {
  return Boolean(row.a_to_b) || Boolean(row.b_to_a);
}

function evaluateVersionRow(
  row: VersionCompatibilityRow,
  nameA: string,
  nameB: string,
): {
  status: CompatibilityStatus;
  confidence: number;
  checks: VersionCheck[];
  signals: string[];
} {
  const checks: VersionCheck[] = [];
  const signals: string[] = [];
  let anyUnsatisfied = false;
  let anySatisfied = false;
  let anyOptionalFail = false;

  if (row.a_to_b && row.version_b) {
    const system = row.a_to_b.range_system as RangeSystem;
    const result = satisfies(row.version_b, row.a_to_b.range, system);
    const check: VersionCheck = {
      from: nameA,
      to: nameB,
      kind: row.a_to_b.kind,
      range: row.a_to_b.range,
      range_system: system,
      satisfied: result.ok,
      reason: result.reason,
    };
    checks.push(check);
    if (result.ok) {
      anySatisfied = true;
      signals.push(
        `${nameA}@${row.version_a} declares ${row.a_to_b.kind} ${nameB} ${row.a_to_b.range} — ${row.version_b} satisfies`,
      );
    } else if (row.a_to_b.kind === 'optional_peer') {
      anyOptionalFail = true;
      signals.push(
        `${nameA}@${row.version_a} declares optional peer ${nameB} ${row.a_to_b.range} — ${row.version_b} does not satisfy (${result.reason ?? 'unknown'})`,
      );
    } else {
      anyUnsatisfied = true;
      signals.push(
        `${nameA}@${row.version_a} requires ${nameB} ${row.a_to_b.range} — ${row.version_b} fails (${result.reason ?? 'unknown'})`,
      );
    }
  }

  if (row.b_to_a && row.version_a) {
    const system = row.b_to_a.range_system as RangeSystem;
    const result = satisfies(row.version_a, row.b_to_a.range, system);
    const check: VersionCheck = {
      from: nameB,
      to: nameA,
      kind: row.b_to_a.kind,
      range: row.b_to_a.range,
      range_system: system,
      satisfied: result.ok,
      reason: result.reason,
    };
    checks.push(check);
    if (result.ok) {
      anySatisfied = true;
      signals.push(
        `${nameB}@${row.version_b} declares ${row.b_to_a.kind} ${nameA} ${row.b_to_a.range} — ${row.version_a} satisfies`,
      );
    } else if (row.b_to_a.kind === 'optional_peer') {
      anyOptionalFail = true;
      signals.push(
        `${nameB}@${row.version_b} declares optional peer ${nameA} ${row.b_to_a.range} — ${row.version_a} does not satisfy (${result.reason ?? 'unknown'})`,
      );
    } else {
      anyUnsatisfied = true;
      signals.push(
        `${nameB}@${row.version_b} requires ${nameA} ${row.b_to_a.range} — ${row.version_a} fails (${result.reason ?? 'unknown'})`,
      );
    }
  }

  let status: CompatibilityStatus;
  let confidence: number;
  if (anyUnsatisfied) {
    status = 'conflicts';
    confidence = 0.95;
  } else if (anySatisfied) {
    status = 'compatible';
    confidence = 0.95;
  } else if (anyOptionalFail) {
    status = 'unknown';
    confidence = 0.65;
  } else {
    status = 'unknown';
    confidence = 0.5;
  }
  return { status, confidence, checks, signals };
}

function buildRecommendation(
  nameA: string,
  nameB: string,
  versionA: string | null,
  versionB: string | null,
  status: CompatibilityStatus,
): string {
  const pairA = versionA ? `${nameA}@${versionA}` : nameA;
  const pairB = versionB ? `${nameB}@${versionB}` : nameB;
  switch (status) {
    case 'compatible':
      return `${pairA} is compatible with ${pairB} according to declared dependency ranges.`;
    case 'conflicts':
      return `${pairA} is NOT compatible with ${pairB} — declared version range is violated. Consider pinning different versions.`;
    case 'requires':
      return `${pairA} requires a specific version of ${pairB}. Check the direction of the REQUIRES edge.`;
    default:
      return `No strong version-level compatibility signal between ${pairA} and ${pairB}.`;
  }
}
