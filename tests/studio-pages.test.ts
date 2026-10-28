import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { studioDir } from './studio.ts';

it('encodes page data, hides reader failures and shares invalidation for external roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-pages-'));
  const external = join(dir, 'external');
  const graph = join(dir, 'graph');
  mkdirSync(external);
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
  writeFileSync(join(graph, 'plugins/pages/Page.tsx'), 'export default function Page() { return <p>Page</p>; }');
  vi.stubEnv('VITE_PRIVATE_CANARY', 'FAKE-private-plugin-value');
  vi.stubEnv('AGI_STUDIO_DIR', graph);
  vi.stubEnv('AGI_STUDIO_DATA', join(dir, 'data'));
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({
    configFile: join(studioDir, 'vite.config.ts'),
    root: studioDir,
    server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
    logLevel: 'silent',
  });
  const controller = new AbortController();
  try {
    await server.listen();
    const base: string = server.resolvedUrls.local[0].replace(/\/$/, '');
    expect(await (await fetch(`${base}/api/plugins/count/data`)).json()).toBe('7');
    expect(await (await fetch(`${base}/src/runs/InboxPage.tsx`)).text()).not.toContain('FAKE-private-plugin-value');
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
    const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
    const second = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    await second.body!.getReader().read();
    writeFileSync(join(external, 'value'), '8');
    const hint = await reader.read();
    expect(new TextDecoder().decode(hint.value)).toContain('data: changed');
    expect(server.watcher.listenerCount('all')).toBe(listeners);
    expect(await (await fetch(`${base}/api/plugins/count/data`)).json()).toBe('8');
  } finally {
    controller.abort();
    await server.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
