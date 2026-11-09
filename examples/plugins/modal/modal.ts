import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { Config, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { makePlugin } from '@jannik-stacks/agi/plugins';
import { makeBoxRunner, type Runner, type RunnerHost, SandboxError } from '@jannik-stacks/agi/runners';

type ModalProcess = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  wait: () => Promise<number>;
};

type ModalSandbox = {
  exec: (
    argv: string[],
    o: { mode: 'binary'; stdout: 'pipe'; stderr: 'pipe'; env: Record<string, string> }
  ) => Promise<ModalProcess>;
  setTags: (tags: Record<string, string>) => Promise<void>;
  getTags: () => Promise<Record<string, string>>;
  terminate: () => Promise<void>;
};

export type ModalClient = {
  apps: { fromName: (name: string, o: { createIfMissing: true }) => Promise<{ appId: string }> };
  images: { fromRegistry: (ref: string) => unknown };
  sandboxes: {
    create: (
      app: { appId: string },
      image: unknown,
      o: { timeoutMs: number; idleTimeoutMs: number } & ({ blockNetwork: true } | { cidrAllowlist: string[] })
    ) => Promise<ModalSandbox>;
    list: (o: { appId: string; tags: Record<string, string> }) => AsyncIterable<ModalSandbox>;
  };
};

const ModalSettings = Schema.Struct({ image: Schema.String, app: Schema.optionalKey(Schema.String) });
type Graph = Parameters<NonNullable<Runner['Service']['whyRefused']>>[0];
type Gateway = { urls: string[]; direct: string[] };

const infra = (detail: string) => new SandboxError({ reason: 'infra', detail });
const call = <A>(what: string, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: e => infra(`modal ${what}: ${(e as Error).message}`) });
const readBytes = (stream: ReadableStream<Uint8Array>) =>
  new Response(stream).arrayBuffer().then(b => new Uint8Array(b));

export const whyModalRefuses = (gateway: Gateway) => (graph: Graph) => {
  const steps = Object.values(graph.workflows).flatMap(w => w.steps);
  const quiet =
    Object.values(graph.checks).some(c => c.run !== undefined) ||
    steps.some(s => 'run' in s.does || !['files', 'hunks'].includes(s.each ?? 'files'));
  const talks = graph.setup !== undefined || steps.some(s => 'agent' in s.does);
  if (graph.network !== 'models')
    return talks ? 'a Modal box holds no egress allowlist; set network: models in settings.yaml' : undefined;
  if (quiet) return 'a Modal box has one network, so it runs no command without network beside sessions';
  const local = [...gateway.direct, ...gateway.urls.filter(url => !url.startsWith('https://'))][0];
  return local && `a Modal box reaches only a public HTTPS model gateway, not ${local}`;
};

const readAllowlist = (urls: string[]) =>
  call('gateway lookup', async () => {
    const found = await Promise.all(urls.map(url => lookup(new URL(url).hostname, { all: true })));
    const cidrs = found.flat().map(a => `${a.address}/${a.family === 4 ? 32 : 128}`);
    if (cidrs.length === 0) throw new Error('no model gateway address to allow');
    return cidrs;
  });

export const makeModalRunner = (
  client: ModalClient,
  settings: typeof ModalSettings.Type,
  host: Pick<RunnerHost, 'data'>,
  gateway: Gateway
): Layer.Layer<Runner, SandboxError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const script = yield* call('box.sh', () =>
        readFile(new URL('../../deploy/cloudflare/box.sh', import.meta.url), 'utf8')
      );
      const app = yield* call('app', () =>
        client.apps.fromName(settings.app ?? 'agentgraph', { createIfMissing: true })
      );
      const image = client.images.fromRegistry(settings.image);
      yield* call('reap', async () => {
        for await (const sb of client.sandboxes.list({ appId: app.appId, tags: { data: host.data } }))
          if (!existsSync((await sb.getTags()).checkout ?? '')) await sb.terminate();
      });
      return makeBoxRunner(
        host.data,
        (work, graph) =>
          Effect.gen(function* () {
            const reach =
              graph?.network === 'models'
                ? { cidrAllowlist: yield* readAllowlist(gateway.urls) }
                : { blockNetwork: true as const };
            const sb = yield* Effect.acquireRelease(
              call('create', () =>
                client.sandboxes.create(app, image, { timeoutMs: 86_400_000, idleTimeoutMs: 1_800_000, ...reach })
              ),
              sb => Effect.ignore(call('terminate', () => sb.terminate()))
            );
            yield* call('tags', () => sb.setTags({ data: host.data, checkout: work.dir }));
            const exec = (argv: string[], env: Record<string, string> = {}, body?: Uint8Array, text = script) =>
              call('exec', async () => {
                const p = await sb.exec(['sh', '-c', text, 'box', ...argv], {
                  mode: 'binary',
                  stdout: 'pipe',
                  stderr: 'pipe',
                  env,
                });
                const writer = p.stdin.getWriter();
                if (body) await writer.write(body);
                await writer.close();
                return p;
              });
            return {
              op: (name, args, body) =>
                Effect.gen(function* () {
                  const p = yield* exec([name === 'stop' ? 'reap' : name, ...args], {}, body);
                  const [out, err, code] = yield* call(name, () =>
                    Promise.all([readBytes(p.stdout), readBytes(p.stderr), p.wait()])
                  );
                  if (code === 0) return out;
                  return yield* infra(`box ${name} exited ${code}: ${new TextDecoder().decode(err).trim()}`);
                }),
              run: (argv, secrets, network, id) =>
                network !== 'none' || 'blockNetwork' in reach
                  ? Stream.unwrap(
                      Effect.map(
                        exec(['run', ...argv], { ...secrets, AGENTGRAPH_RUN: id }, undefined, `exec 2>&1\n${script}`),
                        p =>
                          Stream.fromReadableStream({
                            evaluate: () => p.stdout,
                            onError: e => infra(`modal run: ${(e as Error).message}`),
                          }).pipe(
                            Stream.decodeText(),
                            Stream.splitLines,
                            Stream.concat(
                              Stream.fromEffect(
                                Effect.map(
                                  call('wait', () => p.wait()),
                                  code => ({ code })
                                )
                              )
                            )
                          )
                      )
                    )
                  : Stream.fail(
                      infra('this Modal box reaches the model gateway, so it runs no command without network')
                    ),
            };
          }),
        whyModalRefuses(gateway)
      );
    })
  );

const sdk = String('modal');

export default makePlugin({
  name: 'modal',
  settingsSchema: ModalSettings,
  runner: (host, settings) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const { id, secret, proxy } = yield* Config.all({
          id: Config.Redacted('MODAL_TOKEN_ID'),
          secret: Config.Redacted('MODAL_TOKEN_SECRET'),
          proxy: Config.option(Config.String('AGENTGRAPH_PROXY_URL')),
        }).pipe(Effect.mapError(e => infra(`the modal runner needs ${e.message}`)));
        const { ModalClient } = yield* call(
          'sdk; run npm install modal in the graph folder',
          () =>
            import(sdk) as Promise<{ ModalClient: new (o: { tokenId: string; tokenSecret: string }) => ModalClient }>
        );
        const client = new ModalClient({ tokenId: Redacted.value(id), tokenSecret: Redacted.value(secret) });
        const urls = Option.match(proxy, { onNone: () => [], onSome: url => url.match(/https?:\/\/[^,\s]+/g) ?? [] });
        return makeModalRunner(client, settings, host, { urls, direct: host.direct ?? [] });
      })
    ),
});
