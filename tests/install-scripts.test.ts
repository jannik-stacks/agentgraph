import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const root = join(import.meta.dirname, '..');

const installFixture = (npmrc: string, ...flags: string[]) => {
  const dir = tmp('install');
  const marker = join(dir, 'ran');
  write(dir, {
    'evil/package.json': JSON.stringify({
      name: 'evil',
      version: '1.0.0',
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}', '')"` },
    }),
    'app/package.json': JSON.stringify({ name: 'app', version: '1.0.0', private: true }),
  });
  copyFileSync(npmrc, join(dir, 'app', '.npmrc'));
  const env = { ...process.env, NODE_OPTIONS: '', npm_config_cache: join(dir, 'cache') };
  const quiet = { env, stdio: 'ignore' } as const;
  execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: join(dir, 'evil'), ...quiet });
  execFileSync('npm', ['install', '--offline', '--no-audit', '--no-fund', ...flags, join(dir, 'evil-1.0.0.tgz')], {
    cwd: join(dir, 'app'),
    ...quiet,
  });
  return existsSync(marker);
};

describe('install scripts', () => {
  it.each(['.npmrc', 'studio/.npmrc'])('%s keeps a dependency postinstall from running', npmrc => {
    expect(installFixture(join(root, npmrc), '--ignore-scripts=false')).toBe(true);
    expect(installFixture(join(root, npmrc))).toBe(false);
  });

  it('the sandbox image installs every npm package without scripts', () => {
    const installs = readFileSync(join(root, 'infra/local/sandbox/Dockerfile'), 'utf8').match(/npm install[^&]*/g)!;
    expect(installs).toHaveLength(2);
    for (const line of installs) expect(line).toContain('--ignore-scripts');
  });
});
