import type { ExtractedToolData, ProcessedTool } from '../types.js';

type Relationship = ProcessedTool['relationships'][number];

/**
 * Maps npm package names → canonical tool names as stored in Memgraph.
 * Keys should match exactly what appears in package.json dependencies.
 * Values must match `t.name` in Memgraph exactly (lowercased repo name).
 * This serves as fallback when no existing tools are provided from the graph.
 */
const DEP_TO_TOOL: Record<string, string> = {
  // ── Original seed tools ────────────────────────────────────────────────────
  zod: 'zod',
  hono: 'hono',
  vitest: 'vitest',
  ioredis: 'ioredis',
  'drizzle-orm': 'drizzle-orm',
  prisma: 'prisma',
  '@prisma/client': 'prisma',
  trpc: 'trpc',
  '@trpc/server': 'trpc',
  '@trpc/client': 'trpc',
  '@trpc/react-query': 'trpc',
  express: 'express',
  fastify: 'fastify',
  next: 'next.js',
  svelte: 'svelte',
  vue: 'vue',
  '@angular/core': 'angular',
  '@nestjs/core': 'nest',
  'neo4j-driver': 'memgraph',
  '@qdrant/js-client-rest': 'qdrant',
  '@remix-run/react': 'remix',
  '@remix-run/node': 'remix',
  vite: 'vite',

  // ── Web frameworks ─────────────────────────────────────────────────────────
  'solid-js': 'solid',
  preact: 'preact',
  alpinejs: 'alpine',
  astro: 'astro',
  nuxt: 'nuxt',
  elysia: 'elysia',
  '@sveltejs/kit': 'kit',
  koa: 'koa',
  '@hapi/hapi': 'hapi',

  // ── React ecosystem ────────────────────────────────────────────────────────
  react: 'react',
  swr: 'swr',
  '@tanstack/react-query': 'query',
  '@tanstack/query-core': 'query',
  '@tanstack/react-router': 'router',
  '@tanstack/router': 'router',
  '@tanstack/react-table': 'table',
  '@tanstack/react-form': 'form',
  '@tanstack/virtual-core': 'virtual',
  '@react-three/fiber': 'react-three-fiber',

  // ── Testing ────────────────────────────────────────────────────────────────
  jest: 'jest',
  '@jest/core': 'jest',
  cypress: 'cypress',
  '@playwright/test': 'playwright',
  playwright: 'playwright',
  mocha: 'mocha',
  '@storybook/react': 'storybook',
  '@storybook/core': 'storybook',
  msw: 'msw',
  ava: 'ava',
  '@testing-library/react': 'react-testing-library',
  '@testing-library/user-event': 'react-testing-library',

  // ── Database / ORM ─────────────────────────────────────────────────────────
  typeorm: 'typeorm',
  sequelize: 'sequelize',
  '@mikro-orm/core': 'mikro-orm',
  kysely: 'kysely',
  knex: 'knex',
  mongodb: 'node-mongodb-native',
  mongoose: 'node-mongodb-native',
  payload: 'payload',
  '@payloadcms/richtext-lexical': 'payload',
  '@keystonejs/keystone': 'keystone',

  // ── Auth ───────────────────────────────────────────────────────────────────
  'next-auth': 'next-auth',
  '@auth/core': 'next-auth',
  lucia: 'lucia',
  jose: 'jose',
  '@auth0/node-auth0': 'node-auth0',
  '@supabase/supabase-js': 'supabase-js',

  // ── State management ───────────────────────────────────────────────────────
  redux: 'redux',
  '@reduxjs/toolkit': 'redux',
  zustand: 'zustand',
  jotai: 'jotai',
  mobx: 'mobx',
  pinia: 'pinia',

  // ── UI / CSS ───────────────────────────────────────────────────────────────
  tailwindcss: 'tailwindcss',
  '@radix-ui/react-slot': 'primitives',
  '@radix-ui/react-dialog': 'primitives',
  '@radix-ui/react-popover': 'primitives',
  '@chakra-ui/react': 'chakra-ui',
  antd: 'ant-design',
  '@mui/material': 'material-ui',
  '@mantine/core': 'mantine',
  '@ionic/react': 'ionic-framework',
  '@ionic/angular': 'ionic-framework',

  // ── Build tools ────────────────────────────────────────────────────────────
  rollup: 'rollup',
  parcel: 'parcel',
  esbuild: 'esbuild',
  '@swc/core': 'swc',
  '@babel/core': 'babel',
  webpack: 'webpack',

  // ── HTTP clients ───────────────────────────────────────────────────────────
  axios: 'axios',
  got: 'got',
  'node-fetch': 'node-fetch',
  ofetch: 'ofetch',
  superagent: 'superagent',

  // ── GraphQL ────────────────────────────────────────────────────────────────
  graphql: 'graphql-js',
  '@apollo/client': 'apollo-client',
  'apollo-server': 'apollo-server',
  '@apollo/server': 'apollo-server',
  'graphql-yoga': 'graphql-yoga',

  // ── Validation ─────────────────────────────────────────────────────────────
  joi: 'joi',
  '@hapi/joi': 'joi',
  yup: 'yup',
  valibot: 'valibot',
  superstruct: 'superstruct',

  // ── AI / LLM ───────────────────────────────────────────────────────────────
  langchain: 'langchainjs',
  '@langchain/core': 'langchainjs',
  ai: 'ai',
  openai: 'openai-node',

  // ── Monorepo ───────────────────────────────────────────────────────────────
  nx: 'nx',
  lerna: 'lerna',

  // ── Realtime ───────────────────────────────────────────────────────────────
  'socket.io': 'socket.io',
  'socket.io-client': 'socket.io',
  ws: 'ws',

  // ── Utilities ──────────────────────────────────────────────────────────────
  lodash: 'lodash',
  'date-fns': 'date-fns',
  dayjs: 'dayjs',
  moment: 'moment',
  pino: 'pino',
  winston: 'winston',
  dotenv: 'dotenv',
  async: 'async',

  // ── UnJS ───────────────────────────────────────────────────────────────────
  h3: 'h3',
  nitropack: 'nitro',
  unstorage: 'unstorage',
};

/**
 * Mine raw dep list and description text for tool references.
 * Uses existingTools from graph when available, falls back to DEP_TO_TOOL mapping.
 */
function matchDepsToTools(deps: string[], selfName: string, existingTools?: Set<string>): string[] {
  const found = new Set<string>();

  // First, try to match against existing tools from the graph
  if (existingTools && existingTools.size > 0) {
    for (const dep of deps) {
      // Direct match against existing tool names
      const depLower = dep.toLowerCase();
      if (existingTools.has(depLower) && depLower !== selfName.toLowerCase()) {
        found.add(depLower);
      }
      // Also check the mapping
      const toolName = DEP_TO_TOOL[dep];
      if (
        toolName &&
        toolName.toLowerCase() !== selfName.toLowerCase() &&
        existingTools.has(toolName.toLowerCase())
      ) {
        found.add(toolName.toLowerCase());
      }
    }
  } else {
    // Fall back to the hardcoded mapping
    for (const dep of deps) {
      const toolName = DEP_TO_TOOL[dep];
      if (toolName && toolName !== selfName) {
        found.add(toolName);
      }
    }
  }

  return [...found];
}

function matchDescriptionToTools(
  text: string,
  selfName: string,
  existingTools?: Set<string>,
): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();

  // First, try to match against existing tools from the graph
  if (existingTools && existingTools.size > 0) {
    for (const toolName of existingTools) {
      if (toolName.toLowerCase() === selfName.toLowerCase()) continue;
      // Match the tool name as a whole word in the text
      const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
        found.add(toolName);
      }
    }
  } else {
    // Fall back to the hardcoded mapping
    for (const [pkgName, toolName] of Object.entries(DEP_TO_TOOL)) {
      if (toolName === selfName) continue;
      const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
        found.add(toolName);
      }
    }
  }

  return [...found];
}

/**
 * Extract relationships from a crawled tool.
 * Priority order:
 *   1. package.json declared deps → REQUIRES (high confidence)
 *   2. Repo description text mentions → INTEGRATES_WITH (medium confidence)
 *
 * @param extracted - The extracted tool data
 * @param raw - Raw crawler data containing package.json deps
 * @param existingTools - Optional set of tool names already in the graph for dynamic matching
 */
export function extractRelationships(
  extracted: ExtractedToolData,
  raw: unknown,
  existingTools?: Set<string>,
): Relationship[] {
  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  const rawObj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const packageJsonDeps = Array.isArray(rawObj.deps) ? (rawObj.deps as string[]) : [];

  // 1. Declared deps from package.json — strongest signal
  for (const toolName of matchDepsToTools(packageJsonDeps, extracted.name, existingTools)) {
    if (!seen.has(toolName)) {
      seen.add(toolName);
      relationships.push({
        targetId: toolName,
        edgeType: 'REQUIRES',
        weight: 0.85,
        confidence: 0.9,
        source: 'declared_dependency',
        decayRate: 0.005,
      });
    }
  }

  // 2. Description text mentions — weaker signal
  const descriptionText = extracted.description;
  const repoDescription =
    typeof rawObj.repo === 'object' && rawObj.repo !== null
      ? (((rawObj.repo as Record<string, unknown>).description as string | undefined) ?? '')
      : '';

  for (const toolName of matchDescriptionToTools(
    `${descriptionText} ${repoDescription}`,
    extracted.name,
    existingTools,
  )) {
    if (!seen.has(toolName)) {
      seen.add(toolName);
      relationships.push({
        targetId: toolName,
        edgeType: 'INTEGRATES_WITH',
        weight: 0.5,
        confidence: 0.4,
        source: 'github_signal',
        decayRate: 0.01,
      });
    }
  }

  return relationships;
}
