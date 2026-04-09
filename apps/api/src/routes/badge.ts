/**
 * README Badge endpoint — GET /v1/badge/:owner/:repo
 *
 * Returns an SVG badge showing the tool's quality score and star count.
 * Public endpoint — no auth required, bypassed by CF Worker auth.
 * Cached in CF Worker for 1 hour.
 *
 * Badge usage in a README:
 *   [![ToolCairn](https://api.neurynae.com/v1/badge/facebook/react)](https://toolcairn.neurynae.com/tools/repo/facebook/react)
 */

import { type HealthSignals, computeQualityBreakdown } from '@toolcairn/core';
import { MemgraphToolRepository } from '@toolcairn/graph';
import { Hono } from 'hono';

const repo = new MemgraphToolRepository();

function scoreColor(score: number): string {
  if (score >= 85) return '#22c55e'; // --tp-health-active
  if (score >= 70) return '#818cf8'; // --tp-accent
  if (score >= 50) return '#eab308'; // --tp-health-slowing
  return '#ef4444'; // --tp-health-at-risk
}

function formatStars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function buildSvg(toolName: string, score: number, stars: number): string {
  const color = scoreColor(score);
  const starsText = `★ ${formatStars(stars)}`;
  const scoreText = `${score}/100`;
  const label = toolName.length > 18 ? `${toolName.slice(0, 16)}…` : toolName;

  // Fixed-width SVG badge (shields.io style)
  const leftW = Math.max(80, label.length * 6.5 + 16);
  const rightW = 72;
  const totalW = leftW + rightW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="ToolCairn: ${label} quality ${scoreText}">
  <title>ToolCairn: ${label} — Quality ${scoreText}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalW}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="20" fill="#1e1e2e"/>
    <rect x="${leftW}" width="${rightW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${leftW / 2 + 1}" y="15" fill="#000" fill-opacity=".3">${label}</text>
    <text x="${leftW / 2}" y="14">${label}</text>
    <text x="${leftW + rightW / 2 + 1}" y="15" fill="#000" fill-opacity=".3">${scoreText}</text>
    <text x="${leftW + rightW / 2}" y="14">${scoreText}</text>
  </g>
  <g fill="#ffffffcc" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="9">
    <text x="${leftW / 2}" y="8" opacity="0.7">${starsText}</text>
  </g>
</svg>`;
}

function buildNotIndexedSvg(owner: string, repoName: string): string {
  const label = `${owner}/${repoName}`;
  const display = label.length > 22 ? `${label.slice(0, 20)}…` : label;
  const leftW = 120;
  const rightW = 80;
  const totalW = leftW + rightW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="ToolCairn: not indexed">
  <title>ToolCairn: ${display} — not indexed</title>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="20" fill="#1e1e2e"/>
    <rect x="${leftW}" width="${rightW}" height="20" fill="#6b7280"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${leftW / 2}" y="14">${display}</text>
    <text x="${leftW + rightW / 2}" y="14">not indexed</text>
  </g>
</svg>`;
}

export function badgeRoutes() {
  const app = new Hono();

  app.get('/:owner/:repo', async (c) => {
    const owner = c.req.param('owner');
    const repoName = c.req.param('repo');

    const svgHeaders = {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=7200',
      'X-Content-Type-Options': 'nosniff',
    };

    try {
      // Find tool by matching github_url
      const fragment = `github.com/${owner}/${repoName}`;
      const result = await repo.findByGitHubUrl(fragment);

      if (!result.ok || !result.data) {
        return c.body(buildNotIndexedSvg(owner, repoName), 200, svgHeaders);
      }

      const t = result.data;
      const qs = computeQualityBreakdown(t.health as HealthSignals);
      const svg = buildSvg(t.display_name || t.name, qs.overall, t.health.stars);
      return c.body(svg, 200, svgHeaders);
    } catch {
      return c.body(buildNotIndexedSvg(owner, repoName), 200, svgHeaders);
    }
  });

  return app;
}
