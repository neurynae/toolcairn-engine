/**
 * One-shot migration: upsert canonical runtime Tool nodes so REQUIRES_RUNTIME
 * edges from Version nodes have valid targets.
 *
 * Run once on first deploy (and safely on every deploy — it's idempotent via
 * MERGE on name). Invoke from package root:
 *
 *   pnpm tsx apps/indexer/src/seed/seed-runtime-tools.ts
 */
import { createHash } from 'node:crypto';
import type { ToolNode } from '@toolcairn/core';
import { createLogger } from '@toolcairn/errors';
import { MemgraphToolRepository, closeMemgraphDriver } from '@toolcairn/graph';

const logger = createLogger({ name: '@toolcairn/indexer:seed-runtime-tools' });

interface RuntimeSeed {
  name: string;
  display_name: string;
  description: string;
  homepage: string;
  language: string;
}

const RUNTIMES: RuntimeSeed[] = [
  {
    name: 'node',
    display_name: 'Node.js',
    description: 'JavaScript runtime built on Chrome V8.',
    homepage: 'https://nodejs.org',
    language: 'JavaScript',
  },
  {
    name: 'python',
    display_name: 'Python',
    description: 'Interpreted, high-level programming language.',
    homepage: 'https://www.python.org',
    language: 'Python',
  },
  {
    name: 'deno',
    display_name: 'Deno',
    description: 'Secure runtime for JavaScript and TypeScript.',
    homepage: 'https://deno.com',
    language: 'JavaScript',
  },
  {
    name: 'bun',
    display_name: 'Bun',
    description: 'Fast all-in-one JavaScript runtime, bundler, transpiler, and package manager.',
    homepage: 'https://bun.sh',
    language: 'JavaScript',
  },
  {
    name: 'ruby',
    display_name: 'Ruby',
    description: 'Dynamic, open source programming language.',
    homepage: 'https://www.ruby-lang.org',
    language: 'Ruby',
  },
  {
    name: 'go',
    display_name: 'Go',
    description: 'Statically typed, compiled language from Google.',
    homepage: 'https://go.dev',
    language: 'Go',
  },
  {
    name: 'rust',
    display_name: 'Rust',
    description: 'Systems programming language focused on safety, speed, and concurrency.',
    homepage: 'https://www.rust-lang.org',
    language: 'Rust',
  },
  {
    name: 'java',
    display_name: 'Java',
    description: 'Class-based, object-oriented programming language and runtime.',
    homepage: 'https://www.java.com',
    language: 'Java',
  },
  {
    name: 'php',
    display_name: 'PHP',
    description: 'Popular general-purpose scripting language for web development.',
    homepage: 'https://www.php.net',
    language: 'PHP',
  },
  {
    name: 'dotnet',
    display_name: '.NET',
    description: 'Open-source developer platform for building many kinds of applications.',
    homepage: 'https://dotnet.microsoft.com',
    language: 'C#',
  },
  {
    name: 'elixir',
    display_name: 'Elixir',
    description: 'Dynamic, functional language for building scalable and maintainable apps.',
    homepage: 'https://elixir-lang.org',
    language: 'Elixir',
  },
  {
    name: 'erlang',
    display_name: 'Erlang',
    description: 'General-purpose, concurrent, functional programming language.',
    homepage: 'https://www.erlang.org',
    language: 'Erlang',
  },
  {
    name: 'dart',
    display_name: 'Dart',
    description: 'Client-optimized language for fast apps on multiple platforms.',
    homepage: 'https://dart.dev',
    language: 'Dart',
  },
  {
    name: 'flutter',
    display_name: 'Flutter',
    description: 'UI toolkit for building natively compiled applications.',
    homepage: 'https://flutter.dev',
    language: 'Dart',
  },
  {
    name: 'r',
    display_name: 'R',
    description: 'Language and environment for statistical computing and graphics.',
    homepage: 'https://www.r-project.org',
    language: 'R',
  },
  {
    name: 'julia',
    display_name: 'Julia',
    description: 'High-level dynamic programming language for technical computing.',
    homepage: 'https://julialang.org',
    language: 'Julia',
  },
  {
    name: 'haskell',
    display_name: 'Haskell',
    description: 'Purely functional programming language with lazy evaluation.',
    homepage: 'https://www.haskell.org',
    language: 'Haskell',
  },
  {
    name: 'perl',
    display_name: 'Perl',
    description: 'Family of two high-level, general-purpose, dynamic programming languages.',
    homepage: 'https://www.perl.org',
    language: 'Perl',
  },
  {
    name: 'lua',
    display_name: 'Lua',
    description: 'Lightweight, high-level, multi-paradigm scripting language.',
    homepage: 'https://www.lua.org',
    language: 'Lua',
  },
  {
    name: 'ocaml',
    display_name: 'OCaml',
    description: 'General-purpose multi-paradigm programming language.',
    homepage: 'https://ocaml.org',
    language: 'OCaml',
  },
];

function toolIdFor(name: string): string {
  return `runtime-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}

function buildRuntimeTool(seed: RuntimeSeed): ToolNode {
  const now = new Date().toISOString();
  return {
    id: toolIdFor(seed.name),
    name: seed.name,
    display_name: seed.display_name,
    description: seed.description,
    category: 'runtime',
    github_url: `https://toolcairn.internal/runtime/${seed.name}`,
    homepage_url: seed.homepage,
    license: 'various',
    language: seed.language,
    languages: [seed.language],
    deployment_models: ['self-hosted'],
    package_managers: [],
    topics: ['runtime', 'programming-language'],
    is_fork: false,
    ecosystem_centrality: 0,
    pagerank_score: 0,
    search_weight: 1.0,
    is_canonical: true,
    health: {
      stars: 0,
      stars_velocity_90d: 0,
      last_commit_date: now,
      commit_velocity_30d: 0,
      open_issues: 0,
      closed_issues_30d: 0,
      pr_response_time_hours: 0,
      contributor_count: 0,
      contributor_trend: 0,
      last_release_date: now,
      maintenance_score: 1,
      credibility_score: 1,
      forks_count: 0,
      stars_snapshot_at: now,
      stars_velocity_7d: 0,
      stars_velocity_30d: 0,
    },
    docs: { homepage_url: seed.homepage } as never,
    created_at: now,
    updated_at: now,
  };
}

async function main(): Promise<void> {
  const repo = new MemgraphToolRepository();
  let ok = 0;
  let fail = 0;
  for (const seed of RUNTIMES) {
    try {
      const tool = buildRuntimeTool(seed);
      const result = await repo.createTool(tool);
      if (!result.ok) {
        logger.warn({ name: seed.name, err: result.error.message }, 'createTool failed');
        fail += 1;
      } else {
        ok += 1;
      }
    } catch (e) {
      logger.warn({ name: seed.name, err: e }, 'runtime seed threw');
      fail += 1;
    }
  }
  logger.info({ ok, fail, total: RUNTIMES.length }, 'Runtime seed complete');
  await closeMemgraphDriver();
}

main().catch((e) => {
  logger.error({ err: e }, 'Runtime seed failed');
  process.exit(1);
});
