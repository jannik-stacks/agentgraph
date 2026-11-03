import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { studioDir } from './studio.ts';

it('encodes page data, hides reader failures and sends change topics per watch root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-pages-'));
  const external = join(dir, 'external');
  const graph = join(dir, 'graph');
  mkdirSync(external);
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(graph, 'plugins', 'pages'), { recursive: true });
  writeFileSync(join(external, 'value'), '7');
  writeFileSync(join(graph, 'settings.yaml'), `plugins: { count: { root: ${JSON.stringify(external)} } }\n`);
  const sdk = pathToFileURL(join(studioDir, '../src/plugin.ts')).href;
  for (const [name, dataSchema, read] of [
    [
      'count',
      'Schema.NumberFromString',
      'settings => Effect.sync(() => Number(readFileSync(join(settings.root, "value"), "utf8")))',
    ],
    ['bad', 'Schema.String', '() => Effect.fail(new Error("private-token-and-host-path"))'],
    ['invalid', 'Schema.String', '() => Effect.succeed({ private: "private-token-and-host-path" })'],
    ['big', 'Schema.String', '() => Effect.succeed("x".repeat(16_777_217))'],
  ]) {
    writeFileSync(
      join(graph, 'plugins', `${name}.ts`),
      `
import { makePlugin } from ${JSON.stringify(sdk)};
import { Effect, Schema } from ${JSON.stringify(import.meta.resolve('effect'))};
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export default makePlugin({ name: '${name}',
${name === 'count' ? 'settingsSchema: Schema.Struct({ root: Schema.String }),' : ''}
studio: { title: '${name}', page: new URL('./pages/Page.tsx', import.meta.url),
dataSchema: ${dataSchema}, read: ${read}, ${name === 'count' ? 'watch: settings => [settings.root],' : ''} } });
`
    );
  }
  writeFileSync(
    join(graph, 'plugins/pages/Page.tsx'),
    `import { usePluginData } from '@jannik-stacks/agi/studio';
import { Schema } from 'effect';
export default function Page() { const { value } = usePluginData('count', Schema.NumberFromString); return <p className="text-[27px]">{value}</p>; }`
  );
  vi.stubEnv('VITE_PRIVATE_CANARY', 'FAKE-private-plugin-value');
  vi.stubEnv('AGI_STUDIO_TUNE', join(import.meta.dirname, 'fixtures/tune'));
  vi.stubEnv('AGI_STUDIO_DIR', graph);
  vi.stubEnv('AGI_STUDIO_DATA', join(dir, 'data'));
  vi.stubEnv('AGI_STUDIO_BENCH', external);
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({
    configFile: join(studioDir, 'vite.config.ts'),
    root: studioDir,
    server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
    logLevel: 'silent',
  });
  try {
    await server.listen();
    const base: string = server.resolvedUrls.local[0].replace(/\/$/, '');
    expect(await (await fetch(`${base}/api/plugins/count/data`)).json()).toBe('7');
    expect(await (await fetch(`${base}/src/runs/InboxPage.tsx`)).text()).not.toContain('FAKE-private-plugin-value');
    const snapshot = await (await fetch(`${base}/api/plugins/results/data`)).json();
    expect(snapshot.tune.sheet.runs).toHaveLength(75);
    expect(Object.keys(snapshot.tune.candidates)).toHaveLength(75);
    expect(snapshot.tune.sheet.runs[0]).not.toHaveProperty('step');
    expect(JSON.stringify(snapshot)).not.toContain(external);
    const manifest = await (await fetch(`${base}/@id/__x00__virtual:agentgraph-pages`)).text();
    expect(manifest).toContain('/@id/__x00__virtual:agentgraph-page/count');
    expect(manifest).toContain('href:"/results"');
    expect(manifest).toContain('href:"/bench"');
    expect(await (await fetch(`${base}/api/plugins/bench/data`)).json()).toEqual({ rows: [], drives: [] });
    expect(manifest).not.toContain(external);
    expect(manifest).not.toContain(graph);
    expect((await fetch(`${base}/@fs${realpathSync(join(graph, 'plugins/pages/Page.tsx'))}`)).status).toBe(200);
    expect(await (await fetch(`${base}/src/styles.css`)).text()).toMatch(/font-size:\s*27px/);
    const errors = await Promise.all(
      ['bad', 'invalid', 'big'].map(async name => {
        const response = await fetch(`${base}/api/plugins/${name}/data`);
        return { status: response.status, body: await response.text() };
      })
    );
    expect(errors).toEqual(
      Array.from({ length: 3 }, () => ({ status: 500, body: '{"error":"Could not read plugin data"}' }))
    );
    expect((await fetch(`${base}/api/plugins/missing/data`)).status).toBe(404);
    expect((await fetch(`${base}/api/plugins/count/data`, { method: 'POST' })).status).toBe(405);
    await vi.waitFor(() => expect(server.watcher.getWatched()).toHaveProperty(realpathSync(external)), {
      timeout: 2000,
    });
    const listeners = server.watcher.listenerCount('all');
    const sent = vi.spyOn(server.ws, 'send');
    writeFileSync(join(external, 'value'), '8');
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    expect(sent.mock.calls[0]![0]).toBe('agi:changed');
    expect((sent.mock.calls[0]![1] as { topics: string[] }).topics.toSorted()).toEqual(['bench', 'count', 'results']);
    writeFileSync(join(dir, 'data', 'new'), '');
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    expect((sent.mock.calls[1]![1] as { topics: string[] }).topics.toSorted()).toEqual(['data', 'results']);
    expect(server.watcher.listenerCount('all')).toBe(listeners);
    expect(await (await fetch(`${base}/api/plugins/count/data`)).json()).toBe('8');
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([undefined, 'invalid'])('keeps Results available without a valid graph: %s', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-results-page-'));
  const data = join(dir, 'data');
  mkdirSync(join(data, 'r1'), { recursive: true });
  writeFileSync(join(dir, 'settings.yaml'), 'unknown: true\n');
  writeFileSync(
    join(data, 'r1/run.json'),
    JSON.stringify({
      id: 'r1',
      issue: 1,
      workflow: 'issue',
      status: 'done',
      started: 'now',
      cwd: dir,
      config: { token: 'FAKE-private-results-value' },
      meta: { engine: { origin: { plugin: 'bench', version: 'v1', job: 'smoke', input: { arm: 'candidate' } } } },
    })
  );
  vi.stubEnv('AGI_STUDIO_DIR', mode ? dir : undefined);
  vi.stubEnv('AGI_STUDIO_DATA', data);
  vi.stubEnv('AGI_STUDIO_TUNE', undefined);
  vi.stubEnv('AGI_STUDIO_BENCH', undefined);
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({
    configFile: join(studioDir, 'vite.config.ts'),
    root: studioDir,
    server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
    logLevel: 'silent',
  });
  try {
    await server.listen();
    const base: string = server.resolvedUrls.local[0].replace(/\/$/, '');
    const response = await fetch(`${base}/api/plugins/results/data`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).runs.sheet.runs[0]).toMatchObject({
      key: 'r1',
      axes: { plugin: 'bench', job: 'smoke' },
      meta: { engine: { origin: { input: { arm: 'candidate' } } } },
    });
    expect(text).not.toContain(dir);
    expect(text).not.toContain('FAKE-private-results-value');
    const broken = join(data, 'plugins/broken/job');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'results.json'), '{');
    const partial = await (await fetch(`${base}/api/plugins/results/data`)).json();
    expect(partial.runs.kind).toBe('ready');
    expect(partial.runs.sheet.runs[0].key).toBe('r1');
    expect(partial.exports).toEqual({ kind: 'failed', why: 'Could not read this result source' });
    const manifest = await (await fetch(`${base}/@id/__x00__virtual:agentgraph-pages`)).text();
    expect(manifest).toContain('href:"/results"');
    expect(manifest).not.toContain('bench');
    expect(manifest).not.toContain(dir);
    expect((await fetch(`${base}/@id/__x00__virtual:agentgraph-page/results`)).status).toBe(200);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reloads the served graph and its problems when a graph file changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-served-'));
  writeFileSync(join(dir, 'settings.yaml'), 'unknown: true\n');
  vi.stubEnv('AGI_STUDIO_DIR', dir);
  vi.stubEnv('AGI_STUDIO_DATA', join(dir, 'data'));
  vi.stubEnv('AGI_STUDIO_TUNE', undefined);
  vi.stubEnv('AGI_STUDIO_BENCH', undefined);
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({
    configFile: join(studioDir, 'vite.config.ts'),
    root: studioDir,
    server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
    logLevel: 'silent',
  });
  try {
    await server.listen();
    const base: string = server.resolvedUrls.local[0].replace(/\/$/, '');
    const served = async () => (await fetch(`${base}/@id/__x00__virtual:served`)).text();
    expect(await served()).toContain('unknown');
    const sent = vi.spyOn(server.ws, 'send');
    await vi.waitFor(() => expect(server.watcher.getWatched()).toHaveProperty(realpathSync(dir)), { timeout: 2000 });
    writeFileSync(join(dir, 'settings.yaml'), 'other: true\n');
    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({ type: 'full-reload' }));
    expect(await served()).toContain('other');
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

const check = (description: string) =>
  `---\nmode: info\nreturns: { type: object, required: [n], properties: { n: { type: number, description: ${description} } } }\nrun: "true"\n---\n`;

it('serves a check edit to both result endpoints once the graph reloads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentgraph-served-results-'));
  const dir = join(root, 'graph');
  const files = {
    'agents/a.md': '---\nharness: opencode\n---\n',
    'checks/lines.md': check('before'),
    'workflows/w.md': '---\non: issues\nsteps:\n  x: { agent: a }\nchecks: [lines]\n---\n',
    '../data/r1/run.json': JSON.stringify({ id: 'r1', issue: 1, workflow: 'w', status: 'done', started: 'now' }),
    '../data/r1/checks.jsonl': JSON.stringify({
      at: '1',
      step: 'x',
      version: 'v1',
      check: { check: 'lines', pass: true, value: { n: 3 }, ms: 1 },
    }),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  vi.stubEnv('AGI_STUDIO_DIR', dir);
  vi.stubEnv('AGI_STUDIO_DATA', join(root, 'data'));
  vi.stubEnv('AGI_STUDIO_TUNE', undefined);
  vi.stubEnv('AGI_STUDIO_BENCH', undefined);
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({
    configFile: join(studioDir, 'vite.config.ts'),
    root: studioDir,
    server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
    logLevel: 'silent',
  });
  try {
    await server.listen();
    const base: string = server.resolvedUrls.local[0].replace(/\/$/, '');
    const described = async () => {
      const page = await (await fetch(`${base}/api/plugins/results/data`)).json();
      const runs = await (await fetch(`${base}/api/results?from=runs`)).json();
      return [page.runs.sheet.fields, runs.fields].map(
        (fields: { check?: string; description?: string }[]) => fields.find(f => f.check === 'lines')?.description
      );
    };
    expect(await described()).toEqual(['before', 'before']);
    const sent = vi.spyOn(server.ws, 'send');
    await vi.waitFor(() => expect(server.watcher.getWatched()).toHaveProperty(realpathSync(dir)), { timeout: 2000 });
    writeFileSync(join(dir, 'checks/lines.md'), check('after'));
    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({ type: 'full-reload' }));
    expect(await described()).toEqual(['after', 'after']);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['results', 'bench'])('refuses a graph plugin named after the built-in %s page', async name => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-builtin-name-'));
  mkdirSync(join(dir, 'plugins', 'pages'), { recursive: true });
  writeFileSync(join(dir, 'settings.yaml'), 'plugins: {}\n');
  writeFileSync(join(dir, 'plugins/pages/Page.tsx'), 'export default () => null;');
  writeFileSync(
    join(dir, 'plugins', `${name}.ts`),
    `import { makePlugin } from ${JSON.stringify(pathToFileURL(join(studioDir, '../src/plugin.ts')).href)};
import { Effect, Schema } from ${JSON.stringify(import.meta.resolve('effect'))};
export default makePlugin({ name: '${name}', studio: { title: 'Mine', page: new URL('./pages/Page.tsx', import.meta.url),
dataSchema: Schema.String, read: () => Effect.succeed('') } });
`
  );
  vi.stubEnv('AGI_STUDIO_DIR', dir);
  vi.stubEnv('AGI_STUDIO_DATA', join(dir, 'data'));
  vi.stubEnv('AGI_STUDIO_TUNE', undefined);
  vi.stubEnv('AGI_STUDIO_BENCH', undefined);
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  try {
    await expect(
      createServer({
        configFile: join(studioDir, 'vite.config.ts'),
        root: studioDir,
        server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
        logLevel: 'silent',
      })
    ).rejects.toThrow(`plugins/${name}.ts: plugin ${name} already defined in the built-in plugins`);
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
