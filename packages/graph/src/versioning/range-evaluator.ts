import type { RangeSystem } from '@toolcairn/core';
import semver from 'semver';

export interface SatisfiesResult {
  ok: boolean;
  reason?: string;
}

/**
 * Evaluate whether a concrete version satisfies a declared range under the given system.
 *
 * Adapter strategy:
 * - semver / cargo: npm `semver` package (cargo after a light caret-normalization).
 * - pep440: hand-written comparator evaluator (>=, <=, >, <, ==, !=, ~=, comma-separated AND).
 * - maven: hand-written interval notation evaluator ([x,y), (x,y], etc.) with fallback to soft-equality.
 * - composer: strip PHP-specific wildcards, then reuse semver.
 * - ruby: handle `~>` (twiddle-waka), `>=`, `<`, `!=`, comma-joined AND.
 * - opaque: exact string-equality only.
 */
export function satisfies(version: string, range: string, system: RangeSystem): SatisfiesResult {
  const v = (version || '').trim();
  const r = (range || '').trim();
  if (!v || !r) return { ok: false, reason: 'empty version or range' };

  switch (system) {
    case 'semver':
      return evalSemver(v, r);
    case 'cargo':
      return evalSemver(v, normalizeCargoRange(r));
    case 'composer':
      return evalSemver(v, normalizeComposerRange(r));
    case 'pep440':
      return evalPep440(v, r);
    case 'maven':
      return evalMaven(v, r);
    case 'ruby':
      return evalRuby(v, r);
    case 'opaque':
      return v === r
        ? { ok: true }
        : { ok: false, reason: `range system "opaque" — only exact match evaluable` };
    default:
      return { ok: false, reason: `unknown range system: ${system satisfies never}` };
  }
}

// ─── semver (npm, cargo-after-translate, composer-after-translate) ─────────

function evalSemver(version: string, range: string): SatisfiesResult {
  const coerced = semver.coerce(version)?.version;
  if (!coerced) return { ok: false, reason: `version "${version}" is not a valid semver` };
  try {
    const ok = semver.satisfies(coerced, range, { includePrerelease: true, loose: true });
    return ok ? { ok: true } : { ok: false, reason: `${coerced} does not satisfy ${range}` };
  } catch (e) {
    return { ok: false, reason: `invalid semver range "${range}": ${(e as Error).message}` };
  }
}

/** Cargo's `^0.x.y` pins the minor differently. Translate to an explicit semver range. */
function normalizeCargoRange(range: string): string {
  return range.replace(/\^0\.(\d+)(?:\.(\d+))?/g, (_, minor, patch) =>
    patch
      ? `>=0.${minor}.${patch} <0.${Number(minor) + 1}.0`
      : `>=0.${minor}.0 <0.${Number(minor) + 1}.0`,
  );
}

/** Composer allows `*` wildcards and `||`. Strip wildcards, normalize `||` → `||`. */
function normalizeComposerRange(range: string): string {
  return range
    .replace(/\.\*/g, '.x')
    .replace(/@(dev|stable|RC\d*|beta\d*|alpha\d*)/gi, '')
    .trim();
}

// ─── PEP 440 (Python) ──────────────────────────────────────────────────────

type Pep440Op = '==' | '!=' | '>=' | '<=' | '>' | '<' | '~=' | '===';

interface Pep440Constraint {
  op: Pep440Op;
  version: number[];
}

function parsePep440Version(v: string): number[] {
  // Drop epoch (N!), prerelease (a/b/rc), dev/post, local (+xxx).
  const cleaned = v
    .replace(/^\d+!/, '')
    .replace(/\+.*$/, '')
    .replace(/(a|b|c|rc|dev|post)\d*.*/i, '')
    .trim();
  return cleaned.split('.').map((x) => Number(x) || 0);
}

function parsePep440Constraint(expr: string): Pep440Constraint | null {
  const m = expr.trim().match(/^(===|~=|==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!m) return null;
  return { op: m[1] as Pep440Op, version: parsePep440Version(m[2] ?? '') };
}

function compareTuples(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function evalPep440(version: string, range: string): SatisfiesResult {
  const v = parsePep440Version(version);
  // PEP 440 separates constraints with commas (AND).
  const parts = range
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const c = parsePep440Constraint(part);
    if (!c) return { ok: false, reason: `unparseable pep440 constraint: "${part}"` };
    const cmp = compareTuples(v, c.version);
    let pass = false;
    switch (c.op) {
      case '==':
      case '===':
        pass = cmp === 0;
        break;
      case '!=':
        pass = cmp !== 0;
        break;
      case '>=':
        pass = cmp >= 0;
        break;
      case '<=':
        pass = cmp <= 0;
        break;
      case '>':
        pass = cmp > 0;
        break;
      case '<':
        pass = cmp < 0;
        break;
      case '~=': {
        // ~=X.Y means >=X.Y, <X+1. ~=X.Y.Z means >=X.Y.Z, <X.Y+1.
        const upper = [...c.version];
        upper.pop();
        upper[upper.length - 1] = (upper[upper.length - 1] ?? 0) + 1;
        pass = compareTuples(v, c.version) >= 0 && compareTuples(v, upper) < 0;
        break;
      }
    }
    if (!pass) return { ok: false, reason: `${version} fails ${part}` };
  }
  return { ok: true };
}

// ─── Maven interval notation ───────────────────────────────────────────────

function evalMaven(version: string, range: string): SatisfiesResult {
  const v = parsePep440Version(version); // Maven versions compare numerically like PEP 440.
  const trimmed = range.trim();

  // "1.0" (soft match) — usually means ">=1.0 allowed, but recommended version".
  if (!/^[\[(]/.test(trimmed)) {
    const target = parsePep440Version(trimmed);
    return compareTuples(v, target) >= 0
      ? { ok: true }
      : { ok: false, reason: `${version} < recommended ${trimmed}` };
  }

  const m = trimmed.match(/^([\[(])\s*([^,\s]*)\s*,\s*([^,\s\])]*)\s*([\])])\s*$/);
  if (!m) return { ok: false, reason: `unparseable maven range: "${trimmed}"` };
  const [, lbr, lo, hi, rbr] = m;
  const lowerInc = lbr === '[';
  const upperInc = rbr === ']';
  if (lo) {
    const cmp = compareTuples(v, parsePep440Version(lo));
    if (lowerInc ? cmp < 0 : cmp <= 0)
      return { ok: false, reason: `${version} below lower bound ${lo}` };
  }
  if (hi) {
    const cmp = compareTuples(v, parsePep440Version(hi));
    if (upperInc ? cmp > 0 : cmp >= 0)
      return { ok: false, reason: `${version} above upper bound ${hi}` };
  }
  return { ok: true };
}

// ─── RubyGems ──────────────────────────────────────────────────────────────

function evalRuby(version: string, range: string): SatisfiesResult {
  const v = parsePep440Version(version);
  const parts = range
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^(~>|>=|<=|>|<|!=|=)\s*(.+)$/);
    if (!m) return { ok: false, reason: `unparseable ruby constraint: "${part}"` };
    const [, op, rawVer] = m;
    const target = parsePep440Version(rawVer ?? '');
    const cmp = compareTuples(v, target);
    let pass = false;
    switch (op) {
      case '=':
        pass = cmp === 0;
        break;
      case '!=':
        pass = cmp !== 0;
        break;
      case '>=':
        pass = cmp >= 0;
        break;
      case '<=':
        pass = cmp <= 0;
        break;
      case '>':
        pass = cmp > 0;
        break;
      case '<':
        pass = cmp < 0;
        break;
      case '~>': {
        // Pessimistic: ~>2.1 allows >=2.1, <3.0. ~>2.1.3 allows >=2.1.3, <2.2.0.
        const upper = [...target];
        upper.pop();
        upper[upper.length - 1] = (upper[upper.length - 1] ?? 0) + 1;
        pass = cmp >= 0 && compareTuples(v, upper) < 0;
        break;
      }
    }
    if (!pass) return { ok: false, reason: `${version} fails ${part}` };
  }
  return { ok: true };
}
