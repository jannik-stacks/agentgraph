import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

if (process.argv.includes('--help')) {
  console.log(
    `usage: node slice-repo.mjs [repo] [--ref <branch>]\n\nPrints one JSON line per fact about a repo's tooling, read from the files committed at --ref (HEAD by default): manifests and the install command they imply, package scripts and task runner targets, CI run lines, hooks, tool configs and guides. Pass the branch pull requests merge into when it is not the one checked out.`
  );
  process.exit(0);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { ref: { type: 'string', default: 'HEAD' } },
});
const root = resolve(positionals[0] ?? '.');
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const files = git('ls-tree', '-r', '--name-only', '-z', values.ref).split('\0').filter(Boolean);
const tracked = new Set(files);
const read = path => {
  try {
    return Number(git('cat-file', '-s', `${values.ref}:${path}`)) > 512 * 1024
      ? ''
      : git('show', `${values.ref}:${path}`);
  } catch {
    return '';
  }
};
const lineCount = path => read(path).split('\n').length;
const emit = fact => console.log(JSON.stringify(fact));
const shallow = path =>
  path.split('/').length <= 3 && !/(^|\/)(node_modules|vendor|third_party|fixtures?|examples?)\//.test(path);

const installs = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --immutable (Yarn 2+) or yarn install --frozen-lockfile (Yarn 1)'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['npm-shrinkwrap.json', 'npm ci'],
  ['uv.lock', 'uv sync --frozen'],
  ['poetry.lock', 'poetry install --no-interaction'],
  ['Pipfile.lock', 'pipenv sync --dev'],
  ['requirements.txt', 'pip install -r requirements.txt'],
  ['go.sum', 'go mod download'],
  ['Gemfile.lock', 'bundle install'],
  ['mix.lock', 'mix deps.get'],
  ['composer.lock', 'composer install --no-interaction'],
  ['Cargo.lock', 'none needed: the sandbox fetches crates itself'],
];
for (const [lock, command] of installs) if (tracked.has(lock)) emit({ kind: 'install', lockfile: lock, command });
const manifests = files.filter(
  f =>
    shallow(f) &&
    /^(package\.json|Cargo\.toml|pyproject\.toml|setup\.py|go\.mod|Gemfile|mix\.exs|composer\.json|deno\.jsonc?|build\.gradle(\.kts)?|pom\.xml|Makefile|justfile|Justfile|Taskfile\.ya?ml|\.nvmrc|\.node-version|\.tool-versions|rust-toolchain(\.toml)?|\.python-version)$/.test(
      basename(f)
    )
);
for (const path of manifests) emit({ kind: 'manifest', path });

for (const path of manifests.filter(f => basename(f) === 'package.json')) {
  let pkg;
  try {
    pkg = JSON.parse(read(path));
  } catch {
    continue;
  }
  emit({
    kind: 'package-scripts',
    path,
    packageManager: pkg.packageManager,
    engines: pkg.engines,
    workspaces: pkg.workspaces,
    scripts: pkg.scripts ?? {},
    hooks: pkg['simple-git-hooks'] ?? pkg.husky ?? pkg['lint-staged'],
  });
}
for (const path of manifests.filter(f => /^(Makefile|justfile|Justfile)$/.test(basename(f)))) {
  const targets = [...read(path).matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)/gm)].map(m => m[1]);
  emit({ kind: 'targets', path, targets: [...new Set(targets)] });
}
for (const path of manifests.filter(f => basename(f) === 'pyproject.toml')) {
  const text = read(path);
  emit({ kind: 'pyproject', path, tools: [...new Set([...text.matchAll(/^\[tool\.([\w-]+)/gm)].map(m => m[1]))] });
}
for (const path of manifests.filter(f => basename(f) === 'Cargo.toml')) {
  const text = read(path);
  emit({ kind: 'cargo', path, workspace: /^\[workspace\]/m.test(text), lints: /^\[(workspace\.)?lints/m.test(text) });
}

const runLines = text => {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*(?:-\s+)?)(?:run|script|command):\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, key, rest] = match;
    if (rest && !/^[|>][-+]?\s*$/.test(rest)) {
      out.push({ line: i + 1, run: rest.replace(/^["']|["']$/g, '') });
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].search(/\S/) > key.length); j++)
      body.push(lines[j]);
    const indent = Math.min(...body.filter(l => l.trim()).map(l => l.search(/\S/)));
    const block = body
      .map(l => l.slice(indent))
      .join('\n')
      .trim();
    if (block) out.push({ line: i + 1, run: block });
  }
  return out;
};
const ciFiles = files.filter(f =>
  /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|\.buildkite\/[^/]+\.ya?ml|\.travis\.yml|bitbucket-pipelines\.yml|\.woodpecker\.ya?ml|Jenkinsfile)$/.test(
    f
  )
);
for (const path of ciFiles) {
  const text = read(path);
  const triggers =
    /^on:\s*(.*)$/m.exec(text)?.[1] ||
    [...text.matchAll(/^ {2}(push|pull_request\w*|schedule|workflow_dispatch|release|merge_group):/gm)]
      .map(m => m[1])
      .join(', ');
  const uses = [...new Set([...text.matchAll(/uses:\s*([^\s@#]+)/g)].map(m => m[1]))];
  emit({ kind: 'ci', path, triggers, uses, runs: runLines(text) });
}

const hookFiles = files.filter(f =>
  /^(\.husky\/[^_][^/]*|\.pre-commit-config\.yaml|lefthook\.ya?ml|\.lefthook\.ya?ml|\.lintstagedrc.*|lint-staged\.config\.\w+|\.simple-git-hooks.*|commitlint\.config\.\w+|\.commitlintrc.*)$/.test(
    f
  )
);
for (const path of hookFiles) emit({ kind: 'hook', path, text: read(path).slice(0, 2000) });

const configPattern =
  /^(\.?eslint(rc)?(\.\w+)*|eslint\.config\.\w+|\.oxlintrc\.json|oxlint\.json|\.oxfmtrc\.json|biome\.jsonc?|\.prettierrc(\.\w+)*|prettier\.config\.\w+|tsconfig(\.[\w-]+)*\.json|jsconfig\.json|\.editorconfig|ruff\.toml|\.ruff\.toml|mypy\.ini|\.flake8|\.pylintrc|setup\.cfg|tox\.ini|pytest\.ini|clippy\.toml|\.clippy\.toml|rustfmt\.toml|\.rustfmt\.toml|deny\.toml|\.golangci\.ya?ml|\.markdownlint.*|\.stylelintrc.*|\.rubocop\.yml|knip\.jsonc?|\.knip\.jsonc?|vitest\.config\.\w+|jest\.config\.\w+|playwright\.config\.\w+|\.mocharc.*|\.c8rc.*|\.nycrc.*|codecov\.ya?ml|\.codecov\.ya?ml|dprint\.json|\.swiftlint\.yml|\.clang-format|\.clang-tidy|\.shellcheckrc|cspell\.json|\.cspell\.json|typos\.toml|_typos\.toml|renovate\.json|\.github\/dependabot\.yml)$/;
for (const path of files.filter(f => shallow(f) && (configPattern.test(basename(f)) || configPattern.test(f))))
  emit({ kind: 'config', path, lines: lineCount(path) });

const guidePattern =
  /^(CONTRIBUTING(\.\w+)?|AI_POLICY(\.\w+)?|AI(-|_)?USAGE(\.\w+)?|AGENTS\.md|CLAUDE\.md|GEMINI\.md|STYLE(GUIDE)?(\.\w+)?|CODE_?STYLE(\.\w+)?|DEVELOPMENT(\.\w+)?|HACKING(\.\w+)?|\.cursorrules|\.windsurfrules|\.github\/copilot-instructions\.md|\.github\/pull_request_template\.md|\.github\/PULL_REQUEST_TEMPLATE\.md|\.github\/CODEOWNERS|CODEOWNERS|\.github\/ISSUE_TEMPLATE\/.+|docs\/(contributing|development|style)[^/]*)$/i;
for (const path of files.filter(
  f =>
    guidePattern.test(f) ||
    guidePattern.test(basename(f)) ||
    f.startsWith('.cursor/rules/') ||
    /^\.claude\/(skills|commands|agents)\//.test(f)
))
  emit({ kind: 'guide', path, lines: lineCount(path) });

const testFile = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.\w+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/;
const testDirs = new Map();
for (const f of files.filter(f => testFile.test(f))) {
  const dir = dirname(f).split('/').slice(0, 2).join('/');
  testDirs.set(dir, (testDirs.get(dir) ?? 0) + 1);
}
emit({
  kind: 'tests',
  files: [...testDirs.values()].reduce((a, b) => a + b, 0),
  dirs: Object.fromEntries([...testDirs].toSorted((a, b) => b[1] - a[1]).slice(0, 12)),
});

const top = new Map();
for (const f of files) top.set(f.split('/')[0], (top.get(f.split('/')[0]) ?? 0) + 1);
emit({
  kind: 'layout',
  ref: values.ref,
  files: files.length,
  top: Object.fromEntries([...top].toSorted((a, b) => b[1] - a[1]).slice(0, 20)),
});
if (files.some(f => f.startsWith('.agentgraph/')))
  emit({ kind: 'existing', path: '.agentgraph/', files: files.filter(f => f.startsWith('.agentgraph/')) });
