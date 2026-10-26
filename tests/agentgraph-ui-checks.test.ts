import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { change, runScript } from './kit.ts';

const scripts = resolve(import.meta.dirname, '../examples/agentgraph/scripts');
const studioModules = resolve(import.meta.dirname, '../studio/node_modules');

/** A change with the studio parser linked in. */
const studioChange = (before: Record<string, string>, after: Record<string, string> = {}) => {
  const repo = change(before, after);
  mkdirSync(join(repo.dir, 'studio'), { recursive: true });
  symlinkSync(studioModules, join(repo.dir, 'studio/node_modules'), 'dir');
  return repo;
};

const check = (script: string, repo: { dir: string; base: string }, ...args: string[]) =>
  runScript(join(scripts, script), repo, args);

const silenced = ['@ts-', 'ignore'].join('');
const loose = ['as ', 'any'].join('');
const parsed = ['ReturnType<typeof JSON', '.parse>'].join('');

describe('code-shape check, studio UI rules', () => {
  it('fails the cost tilde, the arrow before its number and the native title the dashboard first shipped with', () => {
    const repo = studioChange(
      {},
      {
        'studio/src/dashboard/bits.tsx': `export const Io = ({ tally }) => (
  <span className="inline-flex" title={\`\${tally.in} in\`}>
    <span className="inline-flex items-center gap-0.5">
      <Icon name="in" title="tokens in" className="size-3" />
      <Num value={tally.in} format={formatTokens} />
    </span>
  </span>
);

export const Cost = ({ billed, estimated }) => {
  const shown = estimated > billed ? estimated : billed;
  const guessed = shown !== billed;
  return (
    <span className="inline-flex items-center tabular-nums">
      {guessed && '~'}
      <Num value={shown} format={formatUsd} />
    </span>
  );
};
`,
      }
    );
    const { ok, out } = check('code-shape.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('studio/src/dashboard/bits.tsx:2: a native title on <span>');
    expect(out).toContain('studio/src/dashboard/bits.tsx:4: an arrow before its number');
    expect(out).toContain('studio/src/dashboard/bits.tsx:15: a tilde on a value');
    expect(out).toContain('code-shape: 3 findings');
  });

  it('fails the summary strip button that explained its icon with a native title', () => {
    const repo = studioChange(
      {},
      {
        'studio/src/dashboard/SummaryStrip.tsx': `const Stat = ({ on, title, onClick, children }) => (
  <button type="button" title={title} aria-pressed={on} onClick={onClick}>
    {children}
  </button>
);
const Refresh = ({ onClick }) => (
  <button type="button" onClick={onClick}>
    <Icon name="refresh" className="size-3.5" />
  </button>
);
`,
      }
    );
    const { ok, out } = check('code-shape.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('SummaryStrip.tsx:2: a native title on <button>');
    expect(out).toContain('SummaryStrip.tsx:7: <button> shows only an icon');
  });

  it('fails the native select, the remove button beside its chip, a loading fallback and a lazy Markdown', () => {
    const repo = studioChange(
      {},
      {
        'studio/src/dashboard/DashboardView.tsx': `const Markdown = lazy(() => import('../Markdown.tsx'));
export const Filters = () => (
  <Suspense fallback={<p className="px-2 py-1 text-xs text-zinc-500">Loading.</p>}>
    <select className="rounded border border-zinc-200 bg-transparent px-1 py-0.5 text-xs">
      <option>all</option>
    </select>
  </Suspense>
);
const RefChip = ({ value, onRemove, target }) => (
  <span className="inline-flex items-center">
    <Chip mono {...target}>{value}</Chip>
    {onRemove && (
      <button type="button" aria-label={\`remove \${value}\`} onClick={onRemove} className="-ml-px px-1">
        ×
      </button>
    )}
  </span>
);
`,
      }
    );
    const { ok, out } = check('code-shape.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('DashboardView.tsx:1: Markdown loaded lazily');
    expect(out).toContain('DashboardView.tsx:3: a "Loading" fallback');
    expect(out).toContain('DashboardView.tsx:4: a native <select>');
    expect(out).toContain('DashboardView.tsx:13: a remove button beside a chip');
  });

  it('fails a second spinner and rows that all animate in', () => {
    const repo = studioChange(
      {},
      {
        'studio/src/dashboard/Groups.tsx': `export const Jobs = ({ jobs }) => (
  <ul>
    {jobs.map(job => (
      <li key={job.id} className="agi-enter flex gap-1">
        <span className="size-3 animate-spin rounded-full border" />
        {job.name}
      </li>
    ))}
  </ul>
);
`,
      }
    );
    const { ok, out } = check('code-shape.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('Groups.tsx:4: enter animation "agi-enter" on every row of a list');
    expect(out).toContain('Groups.tsx:5: animate-spin outside the status icons');
  });

  it('passes the shared primitives used the way the dashboard uses them now', () => {
    const repo = studioChange(
      {},
      {
        'studio/src/dashboard/Clean.tsx': `const Amount = ({ value, glyph }) => (
  <span className="inline-flex items-center">
    <Num value={value} format={formatTokens} />
    <Icon name={glyph} className="size-3" />
  </span>
);
export const Strip = ({ s, onClick, onRemove }) => (
  <Suspense fallback={<div className="h-6" />}>
    <Tooltip tip="Runs live now">
      <button type="button" onClick={onClick}>
        <Icon name="live" className="size-3.5" />
        <Num value={s.live} format={count} />
      </button>
    </Tooltip>
    <span className="tabular-nums">
      {formatTokens(s.carried)}
      <Icon name="in" className="size-3" />
    </span>
    <Select value="all" onChange={() => {}}>
      <option>all</option>
    </Select>
    <RemovableChip label="docs" onRemove={onRemove}>docs</RemovableChip>
    <button type="button" onClick={onClick}>
      <Icon name="chevron" className="size-3" />
      Details
    </button>
  </Suspense>
);
`,
      }
    );
    expect(check('code-shape.mjs', repo)).toEqual({ ok: true, out: 'code-shape: ok' });
  });

  it('counts only the lines a change adds, and reports a file it cannot parse', () => {
    const old = '<select className="x">\n  <option>a</option>\n</select>';
    const repo = studioChange(
      { 'studio/src/Old.tsx': `export const A = () => (\n  ${old}\n);\n` },
      {
        'studio/src/Old.tsx': `export const A = () => (\n  ${old}\n);\nexport const B = () => <span className="text-xs" />;\n`,
        'studio/src/Broken.tsx': 'export const C = () => <div>;\n',
      }
    );
    const { ok, out } = check('code-shape.mjs', repo);
    expect(ok).toBe(false);
    expect(out).not.toContain('Old.tsx');
    expect(out).toContain('studio/src/Broken.tsx:1: does not parse');
  });
});

describe('code-shape check', () => {
  it('fails an inline component, an eager route and a union keyed on kind', () => {
    const repo = studioChange(
      {},
      {
        'src/outputs.ts': "export const Proposal = z.discriminatedUnion('kind', [reply, label]);\n",
        'studio/src/App.tsx': `import { DashboardView } from './dashboard/DashboardView.tsx';
import { sum } from '../../src/usage.ts';
export const App = () => {
  const Row = ({ n }) => <li>{n}</li>;
  const Lazy = lazy(() => import('./x.tsx'));
  return <Row n={sum(1, 2)} />;
};
`,
      }
    );
    const { ok, out } = check('code-shape.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('src/outputs.ts:1: a union told apart by "kind"; use "type"');
    expect(out).toContain('studio/src/App.tsx:1: imports ./dashboard/DashboardView.tsx eagerly');
    expect(out).toContain('studio/src/App.tsx:4: component Row defined inside a function');
    expect(out).toContain('studio/src/App.tsx:5: component Lazy defined inside a function');
  });

  it('passes module-level components and lazy routes', () => {
    const repo = studioChange(
      {},
      {
        'src/hub.ts': "export const Check = z.discriminatedUnion('type', [script, bot]);\n",
        'studio/src/App.tsx': `import type { Route } from './state.ts';
const DashboardView = lazy(() => import('./dashboard/DashboardView.tsx'));
const Row = ({ n }: { n: number }) => <li>{n}</li>;
export const App = () => {
  const rows = [1, 2].map(n => <Row key={n} n={n} />);
  return <ul>{rows}</ul>;
};
`,
      }
    );
    expect(check('code-shape.mjs', repo)).toEqual({ ok: true, out: 'code-shape: ok' });
  });

  it('hints at state copied in an effect and a type union keyed on kind, without failing', () => {
    const repo = studioChange(
      {},
      {
        'studio/src/Field.tsx': `export const Field = ({ value }) => {
  const [text, setText] = useState('');
  useEffect(() => setText(String(value)), [value]);
  return <input value={text} />;
};
type Item = { kind: 'text'; text: string } | { kind: 'tool'; name: string };
`,
      }
    );
    const { ok, out } = check('code-shape.mjs', repo);
    expect(ok).toBe(true);
    expect(out).toContain('studio/src/Field.tsx:3: hint: an effect that only sets state');
    expect(out).toContain('studio/src/Field.tsx:6: hint: a union told apart by "kind"; prefer "type"');
    expect(out.split('\n').at(-1)).toBe('code-shape: ok');
  });

  it('fails a hub script field that sends the whole repository to a model, and passes a clipped one', () => {
    const repo = studioChange(
      {},
      {
        'examples/agentgraph/scripts/slice.mjs': `const all = execFileSync('git', ['ls-files']).split('\\n').map(path => readFileSync(path));
const some = all.slice(0, maxHelpers);
const rows = criteria.map(c => c.text);
console.log(JSON.stringify({ path: 'change', rows, ...(all.length && {
  every: all.join('\\n'),
  some,
}) }));
`,
      }
    );
    const { ok, out } = check('code-shape.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('examples/agentgraph/scripts/slice.mjs:5: a field sent to a model with no clip or limit');
    expect(out).toContain('code-shape: 1 finding');
  });
});

describe('rules check, guards', () => {
  it('fails a skip switch, the sandbox off, a self-approving harness and a silenced type error', () => {
    const repo = studioChange(
      {},
      {
        'src/hub.ts': 'export const Workflow = z.strictObject({ allowSkip: z.boolean().optional() });\n',
        'examples/hub/hub.yaml': 'sandbox: none\n',
        'src/harnesses/pi.ts': "export const args = ['--dangerously-skip-permissions'];\n",
        'src/queue.ts': `// ${silenced}\nexport const q = (x ${loose}).y;\n`,
        'src/workspace.ts': "await run(['push', '--force', 'origin', branch]);\n",
        'src/wire.ts': `type Line = ${parsed};\nconst rows: Array<${'any'}> = [];\n`,
      }
    );
    const { ok, out } = check('rules.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('src/hub.ts:1: a way to skip checks');
    expect(out).toContain('examples/hub/hub.yaml:1: the sandbox switched off');
    expect(out).toContain('src/harnesses/pi.ts:1: a harness that approves its own tool calls');
    expect(out).toContain('src/queue.ts:1: a silenced type error');
    expect(out).toContain('src/queue.ts:2: an `any` that hides a type');
    expect(out).toContain('src/workspace.ts:1: a force push');
    expect(out).toContain('src/wire.ts:1: an `any` that hides a type');
    expect(out).toContain('src/wire.ts:2: an `any` that hides a type');
  });

  it('passes the unsandboxed launcher in tests, removal with force and raw HTML', () => {
    const repo = studioChange(
      {},
      {
        'tests/runner.test.ts':
          "import { unsandboxed } from '../src/runner.ts';\nconst flags = /--yolo|dangerously/;\n",
        'src/store.ts': 'await rm(dir, { recursive: true, force: true });\n',
        'studio/src/code/components.tsx':
          'export const H = ({ html }) => <code dangerouslySetInnerHTML={{ __html: html }} />;\n',
      }
    );
    expect(check('rules.mjs', repo)).toEqual({ ok: true, out: 'rules: ok' });
  });
});

describe('rules check, unfinished code', () => {
  it('fails markers for later and fakes in shipped code', () => {
    const repo = studioChange(
      {},
      {
        'src/harnesses/opencode.ts': "// TODO wire the real model\nexport const reply = () => 'fake answer';\n",
        'bin/agentgraph.mjs': "throw new Error('not implemented');\n",
      }
    );
    const { ok, out } = check('rules.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('src/harnesses/opencode.ts:1: a marker for later');
    expect(out).toContain('src/harnesses/opencode.ts:2: a fake in shipped code');
    expect(out).toContain('bin/agentgraph.mjs:1: a path that is not implemented');
  });

  it('passes fakes in the simulator and tests, and placeholder text', () => {
    const repo = studioChange(
      {},
      {
        'src/sim.ts': 'export const fake = () => 1;\n',
        'tests/a.test.ts': 'const stub = () => 1;\n',
        'studio/src/Search.tsx': 'export const S = () => <input placeholder="a dummy name" />;\n',
      }
    );
    expect(check('rules.mjs', repo)).toEqual({ ok: true, out: 'rules: ok' });
  });
});

describe('rules check, retired names', () => {
  it('fails replaced names in code, docs and hub files', () => {
    const repo = studioChange(
      {},
      {
        'src/executors/pi.ts': 'export const executor = 1;\n',
        'examples/hub/agents/triager.md': '---\nsoul: careful\ncan: [comment]\n---\n',
        'docs/loop.md': 'Each check runs for-each changed file.\n',
      }
    );
    const { ok, out } = check('rules.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('src/executors/pi.ts:1: executor; find a clearer word, for example harness');
    expect(out).toContain('examples/hub/agents/triager.md:2: soul; find a clearer word, for example agent');
    expect(out).toContain('examples/hub/agents/triager.md:3: `can:`; find a clearer word, for example `returns:`');
    expect(out).toContain('docs/loop.md:1: for-each; find a clearer word, for example `each:`');
  });

  it('passes a hint that rejects the old name', () => {
    const repo = studioChange(
      {},
      {
        'src/hub.ts': `issue.input === 'open-pr'\n  ? 'there is no "open-pr"; a request to merge a branch is "pull_request"'\n`,
        'tests/schema.test.ts': "expect(parse({ soul: 'x' })).toThrow();\n",
      }
    );
    expect(check('rules.mjs', repo)).toEqual({ ok: true, out: 'rules: ok' });
  });
});

describe('rules check, new checks', () => {
  const checkFile = (mode: string, body: string) => `---\nmode: ${mode}\nrun: node x.mjs\n---\n${body}\n`;

  it.each(['block', 'stop'])('fails a new check in %s mode whose body names no calibration', mode => {
    const repo = change({}, { 'examples/hub/checks/new.md': checkFile(mode, 'Issue 3.') });
    expect(check('rules.mjs', repo)).toEqual({
      ok: false,
      out: 'examples/hub/checks/new.md:1: a new check in block or stop mode with no calibration; start it in warn mode, or say in its body which replay calibrated it\nrules: 1 finding',
    });
  });

  it('passes a calibrated or warn new check and an existing block check', () => {
    const repo = change(
      { 'examples/hub/checks/old.md': checkFile('block', 'Seed hub.') },
      {
        'examples/hub/checks/old.md': checkFile('block', 'Seed hub, tightened.'),
        'examples/hub/checks/calibrated.md': checkFile('block', 'A replay of 60 commits flagged 3, all real.'),
        'examples/hub/checks/warned.md': checkFile('warn', 'Issue 3.'),
      }
    );
    expect(check('rules.mjs', repo)).toEqual({ ok: true, out: 'rules: ok' });
  });
});

describe('rules check, docs prose', () => {
  const fence = '```';
  it('fails dates, internal references, filler words, whole-file sources and long code blocks', () => {
    const long = Array.from({ length: 35 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const repo = studioChange(
      {},
      {
        'docs/runs.md': `Since 2026-09-21 a run keeps its log.
See decision 0054 for the scenarios.
Runs leverage a robust store.
<Source file="src/runner.ts" />

${fence}ts
${long}
${fence}
`,
      }
    );
    const { ok, out } = check('rules.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('runs.md:1: a date');
    expect(out).toContain('runs.md:2: an internal reference');
    expect(out).toContain('runs.md:3: a marketing or filler word');
    expect(out).toContain('runs.md:4: <Source> shows a whole file');
    expect(out).toContain('runs.md:6: a 35-line code block');
  });

  it('passes plain prose and a source excerpt', () => {
    const repo = studioChange(
      {},
      {
        'docs/runs.md': `A run keeps its log in the store.\n<Source file="src/runner.ts" symbol="output" />\n<Source file="package.json" />\n`,
      }
    );
    expect(check('rules.mjs', repo)).toEqual({ ok: true, out: 'rules: ok' });
  });
});

describe('docs-sync check', () => {
  it('fails a new schema no docs page names, and passes once one does', () => {
    const schema = 'export const Budget = Schema.Struct({ usd: Schema.Number });\n';
    const missing = studioChange(
      { 'docs/reference/config.md': 'See `Bot` in src/hub.ts.\n' },
      { 'src/hub.ts': schema }
    );
    const { ok, out } = check('docs-sync.mjs', missing);
    expect(ok).toBe(false);
    expect(out).toContain('src/hub.ts:1: Budget is in no docs page');

    const named = studioChange(
      { 'docs/reference/config.md': 'See `Bot` in src/hub.ts.\n' },
      { 'src/hub.ts': schema, 'docs/reference/config.md': 'See `Budget` in src/hub.ts.\n' }
    );
    expect(check('docs-sync.mjs', named)).toEqual({ ok: true, out: 'docs-sync: ok' });
  });
});

describe('docs-mentions script', () => {
  it('prints the docs paragraphs that name an export the change touches, and no others', () => {
    const docs = 'docs/sandbox.md';
    const code = '/** Env. */\nexport const cacheEnv = { A: 1 };\n\nexport const other = 2;\n';
    const repo = change(
      { 'src/box.ts': code, [docs]: 'Intro.\n\n<Sym name="cacheEnv" /> shares the target.\n\nAbout `other`.\n' },
      { 'src/box.ts': code.replace('A: 1', 'A: 2') }
    );
    const { ok, out } = check('docs-mentions.mjs', repo, 'src/', 'docs/');
    expect(ok).toBe(true);
    expect(out.split('\n').map(line => JSON.parse(line))).toEqual([
      {
        file: docs,
        line: 3,
        hunk: '<Sym name="cacheEnv" /> shares the target.',
        'changed code': ['cacheEnv in src/box.ts'],
      },
    ]);
  });
});

describe('unused-exports check', () => {
  it('fails an export no other file uses and passes one that is imported', () => {
    const repo = studioChange(
      { 'src/live.ts': '' },
      {
        'src/usage.ts': 'export const sum = (a: number) => a;\nexport const spare = 1;\n',
        'src/live.ts': "import { sum } from './usage.ts';\nexport const live = sum(1);\n",
        'tests/live.test.ts': "import { live } from '../src/live.ts';\n",
      }
    );
    const { ok, out } = check('unused-exports.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('src/usage.ts:2: spare is exported but no other file uses it');
    expect(out).toContain('unused-exports: 1 finding');
  });
});

describe('tooltips slicer', () => {
  it('prints one item per tooltip the change adds', () => {
    const repo = studioChange(
      { 'studio/src/A.tsx': 'export const A = () => <Tooltip tip="old">a</Tooltip>;\n' },
      {
        'studio/src/A.tsx':
          'export const A = () => <Tooltip tip="old">a</Tooltip>;\nexport const B = () => <Tooltip tip="Runs live now">b</Tooltip>;\n',
      }
    );
    const { ok, out } = check('tooltips.mjs', repo);
    expect(ok).toBe(true);
    const items = out.split('\n').map(line => JSON.parse(line));
    expect(items).toEqual([
      expect.objectContaining({ file: 'studio/src/A.tsx', line: 2, element: 'Tooltip', tip: 'Runs live now' }),
    ]);
  });
});
