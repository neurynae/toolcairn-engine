/**
 * Description enrichment utilities.
 *
 * Many tools have short, vague, or marketing-focused descriptions that carry
 * no searchable signal — e.g. yargs: "pirate-themed successor to optimist".
 * Package registries provide structured keywords that describe what the tool
 * actually does (e.g. ["argument", "cli", "parser", "command"]).
 *
 * This module appends those keywords to the description when the description
 * is too short to be useful, giving BM25 and vector search meaningful signal.
 */

const ENRICHMENT_THRESHOLD = 100; // characters

/**
 * Append keywords to a description when the description is too short
 * to carry meaningful search signal.
 *
 * Only adds keywords that don't already appear in the description (case-insensitive)
 * to avoid redundancy and token inflation.
 */
export function enrichDescription(description: string, keywords: string[]): string {
  const base = description.trim();
  if (base.length >= ENRICHMENT_THRESHOLD || keywords.length === 0) return base;

  const baseLower = base.toLowerCase();
  const newKeywords = keywords
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 1 && !baseLower.includes(k));

  if (newKeywords.length === 0) return base;

  const suffix = newKeywords.join(' ');
  return base ? `${base} ${suffix}` : suffix;
}
