import { describe, expect, it } from 'vitest';
import {
  type DiscoveredPackage,
  discoverDistributionChannels,
  parseInstallCommands,
} from './readme-install-parser.js';

/**
 * Wrap a raw install command in a fenced code block so parseInstallCommands
 * sees it (it only matches inside ``` blocks).
 */
function codeBlock(lines: string): string {
  return `\`\`\`bash\n${lines}\n\`\`\`\n`;
}

/** Find the command that produced a given (registry, packageName). */
function find(
  list: DiscoveredPackage[],
  registry: string,
  pkg: string,
): DiscoveredPackage | undefined {
  return list.find((c) => c.registry === registry && c.packageName === pkg);
}

describe('parseInstallCommands — flag rejection', () => {
  it('does not capture `--save` as an npm package', () => {
    const commands = parseInstallCommands(codeBlock('npm install --save express'));
    expect(find(commands, 'npm', '--save')).toBeUndefined();
    expect(find(commands, 'npm', 'express')).toBeDefined();
  });

  it('does not capture `--save-dev`, `--unsafe-perm` on npm', () => {
    const commands = parseInstallCommands(
      codeBlock('npm install --save-dev --unsafe-perm @types/node'),
    );
    expect(find(commands, 'npm', '--save-dev')).toBeUndefined();
    expect(find(commands, 'npm', '--unsafe-perm')).toBeUndefined();
    expect(find(commands, 'npm', '@types/node')).toBeDefined();
  });

  it('does not capture yarn/pnpm/bun flags', () => {
    const samples = [
      { cmd: 'yarn add --dev jest', expect: 'jest' },
      { cmd: 'pnpm add --save-dev vitest', expect: 'vitest' },
      { cmd: 'bun add --dev tsx', expect: 'tsx' },
    ];
    for (const s of samples) {
      const commands = parseInstallCommands(codeBlock(s.cmd));
      const dashed = commands.find((c) => c.packageName.startsWith('-'));
      expect(dashed, `should not capture a flag from: ${s.cmd}`).toBeUndefined();
      expect(find(commands, 'npm', s.expect)).toBeDefined();
    }
  });

  it('does not capture `-r` from pip', () => {
    // `-r` is consumed by FLAGS. The file arg `requirements.txt` is technically
    // captured by the regex (it looks like a valid-shape package name), but
    // downstream registry verification rejects it (no such PyPI package).
    // The guarantee here is only that `-r` itself isn't captured.
    const commands = parseInstallCommands(codeBlock('pip install -r requirements.txt'));
    expect(find(commands, 'pypi', '-r')).toBeUndefined();
    expect(find(commands, 'pypi', '--')).toBeUndefined();
  });

  it('does not capture `--upgrade` from pip', () => {
    const commands = parseInstallCommands(codeBlock('pip install --upgrade sentry-sdk'));
    expect(find(commands, 'pypi', '--upgrade')).toBeUndefined();
    expect(find(commands, 'pypi', 'sentry-sdk')).toBeDefined();
  });

  it('does not capture `--locked` from cargo', () => {
    const commands = parseInstallCommands(codeBlock('cargo install --locked ripgrep'));
    expect(find(commands, 'crates', '--locked')).toBeUndefined();
    expect(find(commands, 'crates', 'ripgrep')).toBeDefined();
  });

  it('does not capture `-it` from docker run', () => {
    const commands = parseInstallCommands(codeBlock('docker run -it redis'));
    expect(find(commands, 'docker', '-it')).toBeUndefined();
    expect(find(commands, 'docker', 'redis')).toBeDefined();
  });

  it('handles flags with =value form', () => {
    const commands = parseInstallCommands(
      codeBlock('npm install --registry=https://registry.npmjs.org/ express'),
    );
    // Neither the flag nor its URL should be captured
    const dashed = commands.find((c) => c.packageName.startsWith('-'));
    expect(dashed).toBeUndefined();
    expect(find(commands, 'npm', 'express')).toBeDefined();
  });
});

describe('parseInstallCommands — correct captures', () => {
  it('captures scoped npm packages', () => {
    const commands = parseInstallCommands(codeBlock('npm install @types/node'));
    expect(find(commands, 'npm', '@types/node')).toBeDefined();
  });

  it('captures composer vendor/pkg', () => {
    const commands = parseInstallCommands(codeBlock('composer require laravel/framework'));
    expect(find(commands, 'packagist', 'laravel/framework')).toBeDefined();
  });

  it('captures docker namespaced image', () => {
    const commands = parseInstallCommands(codeBlock('docker pull ghcr.io/foo/bar'));
    expect(find(commands, 'docker', 'ghcr.io/foo/bar')).toBeDefined();
  });

  it('captures go github.com module', () => {
    const commands = parseInstallCommands(codeBlock('go install github.com/spf13/cobra@latest'));
    expect(find(commands, 'go', 'github.com/spf13/cobra')).toBeDefined();
  });

  it('captures pip without flags', () => {
    const commands = parseInstallCommands(codeBlock('pip install fastapi'));
    expect(find(commands, 'pypi', 'fastapi')).toBeDefined();
  });

  it('captures cargo without flags', () => {
    const commands = parseInstallCommands(codeBlock('cargo install cargo-watch'));
    expect(find(commands, 'crates', 'cargo-watch')).toBeDefined();
  });

  it('captures brew formulas', () => {
    const commands = parseInstallCommands(codeBlock('brew install ripgrep'));
    expect(find(commands, 'homebrew', 'ripgrep')).toBeDefined();
  });

  it('captures npx short form', () => {
    const commands = parseInstallCommands(codeBlock('npx create-next-app@latest'));
    expect(find(commands, 'npm', 'create-next-app')).toBeDefined();
  });
});

describe('discoverDistributionChannels — fallback fuzzy guard', () => {
  it('rejects fallback capture when it does not fuzzy-match repo/owner', () => {
    // This is the exact llm-scraper bug: its README shows
    // `npm install zod playwright llm-scraper` under Installation. Pre-fix,
    // `zod` (the first captured package on that line) became llm-scraper's
    // distribution channel. Post-fix, the fuzzy guard rejects `zod` and the
    // parser's one-package-per-line limit means `llm-scraper` isn't captured
    // either — conservative empty is strictly better than confidently wrong.
    const readme = [
      '# llm-scraper',
      '',
      '## Installation',
      '',
      '```bash',
      'npm install zod playwright llm-scraper',
      '```',
      '',
    ].join('\n');
    const channels = discoverDistributionChannels(readme, 'llm-scraper', 'mishushakov', []);
    expect(channels.find((c) => c.packageName === 'zod')).toBeUndefined();
    // Conservative — neither captured. Downstream the MCP resolver's Tier 2
    // (github_url) still finds the tool correctly.
    expect(channels.filter((c) => c.registry === 'npm')).toEqual([]);
  });

  it('accepts fallback capture when it fuzzy-matches', () => {
    // Repo `express` with a README "Installation" section showing `npm install express`.
    const readme = [
      '# express',
      '',
      '## Installation',
      '',
      '```bash',
      'npm install express',
      '```',
      '',
    ].join('\n');
    const channels = discoverDistributionChannels(readme, 'express', 'expressjs', []);
    expect(channels.find((c) => c.registry === 'npm' && c.packageName === 'express')).toBeDefined();
  });

  it('returns empty when the README only shows unrelated dep installs', () => {
    // Repo `my-tool` by `my-org`. README has only `npm install <dependency>`
    // for a dep that is NOT fuzzy-related to the tool.
    const readme = [
      '# my-tool',
      '',
      '## Installation',
      '',
      '```bash',
      'npm install lodash',
      '```',
      '',
    ].join('\n');
    const channels = discoverDistributionChannels(readme, 'my-tool', 'my-org', []);
    expect(channels.filter((c) => c.registry === 'npm')).toEqual([]);
  });
});

describe('parseInstallCommands — pip prefix variations', () => {
  it('matches `python -m pip install` (gpt-engineer style)', () => {
    const cmds = parseInstallCommands(codeBlock('python -m pip install gpt-engineer'));
    expect(find(cmds, 'pypi', 'gpt-engineer')).toBeDefined();
  });

  it('matches `python3 -m pip install`', () => {
    const cmds = parseInstallCommands(codeBlock('python3 -m pip install requests'));
    expect(find(cmds, 'pypi', 'requests')).toBeDefined();
  });

  it('matches `sudo pip install`', () => {
    const cmds = parseInstallCommands(codeBlock('sudo pip install ansible'));
    expect(find(cmds, 'pypi', 'ansible')).toBeDefined();
  });

  it('matches `! pip install` (Jupyter notebook style)', () => {
    const cmds = parseInstallCommands(codeBlock('! pip install pandas'));
    expect(find(cmds, 'pypi', 'pandas')).toBeDefined();
  });

  it("matches quoted package names: `pip install 'markitdown[all]'`", () => {
    // microsoft/markitdown documents the install with a single-quoted form
    // to make the extras specifier shell-safe. The pkg capture must skip
    // the leading quote, then stop at `[`.
    const cmds = parseInstallCommands(codeBlock("pip install 'markitdown[all]'"));
    expect(find(cmds, 'pypi', 'markitdown')).toBeDefined();
  });

  it('matches double-quoted package names: `pip install "openbb[all]"`', () => {
    const cmds = parseInstallCommands(codeBlock('pip install "openbb[all]"'));
    expect(find(cmds, 'pypi', 'openbb')).toBeDefined();
  });
});

describe('parseInstallCommands — source field', () => {
  it('tags README-discovered channels with source: "readme"', () => {
    const cmds = parseInstallCommands(codeBlock('npm install express'));
    const ch = find(cmds, 'npm', 'express');
    expect(ch?.source).toBe('readme');
  });

  it('tags topic-discovered channels with source: "topic"', () => {
    // Empty README + topic that maps to a registry hint.
    const channels = discoverDistributionChannels('', 'rust-lang-tool', 'someone', ['rust']);
    const cratesChannel = channels.find((c) => c.registry === 'crates');
    if (cratesChannel) {
      expect(cratesChannel.source).toBe('topic');
    }
  });
});
