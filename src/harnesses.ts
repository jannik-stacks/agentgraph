import { getSettings } from './settings.ts';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open as openFile, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Config, ConfigProvider, Effect, Layer, Option, Redacted, Stream } from 'effect';
import { type Graph, type HarnessCheck, GraphError, loadGraph } from './folder.ts';
import { Sandbox, type SandboxError } from './sandbox.ts';
import { getListPriceUsd, type Prices, readPrices } from './prices.ts';
import { Session } from './session.ts';
import { formatRedactedText } from './context.ts';
import { type Command, type Exit, type SessionEvent, type SessionSpec, SessionStop } from './types.ts';

export type Piece =
  | { type: 'session'; id: string; model?: string }
  | Extract<SessionEvent, { type: 'text' | 'thinking' | 'tool' | 'usage' }>
  | { type: 'done'; ended: Extract<SessionEvent, { type: 'end' }>['ended']; error?: string };

type ModelRoute = { url: string; model: string; auth?: string };

export type Harness = HarnessCheck & {
  key: string;
  home?: (
    spec: Omit<SessionSpec, 'model'>,
    route: ModelRoute
  ) => { files?: Record<string, string | null>; links?: Record<string, string> };
  command: (
    spec: Omit<SessionSpec, 'model'>,
    route: ModelRoute
  ) => Pick<Command, 'cmd' | 'args'> & Partial<Pick<Command, 'env' | 'readonly'>> & { input: string };
  parse: () => (line: unknown) => Piece[];
};

export type Provider = {
  name: string;
  harnesses: string[];
  auth?: ModelRoute['auth'];
  ready: (host: { image: string; env: Record<string, string> }) => boolean | Promise<boolean>;
  detect?: (host: Parameters<Provider['ready']>[0]) => boolean;
  setup?: string;
  whyLogin?: () => string;
  settings?: (host: Parameters<Provider['ready']>[0]) => Record<string, string> | Promise<Record<string, string>>;
  login?: (host: Parameters<Provider['ready']>[0]) => Promise<void>;
};

export type HarnessSettings = { harnesses: Harness[]; providers?: Provider[]; harness?: string; provider?: string };

export const readHarnessSettings = Effect.gen(function* () {
  const file = yield* Effect.orDie(Config.String('AGENTGRAPH_CONFIG').pipe(Config.withDefault('')));
  const path = file ? resolve(file) : 'agentgraph.config.ts';
  const harness = yield* Effect.orDie(Config.String('AGENTGRAPH_HARNESS').pipe(Config.withDefault('')));
  const named = yield* Effect.orDie(Config.String('AGENTGRAPH_PROVIDER').pipe(Config.withDefault('')));
  return yield* Effect.tryPromise({
    try: async () => {
      const settings: HarnessSettings | undefined = (
        await (file ? import(pathToFileURL(path).href) : import('#config'))
      ).default;
      if (!Array.isArray(settings?.harnesses)) throw new Error('has no default export with a harnesses list');
      const names = settings.harnesses.map(h => h.name);
      const twice = names.find((name, i) => names.indexOf(name) !== i);
      if (twice) throw new Error(`lists the harness ${twice} twice`);
      const providers = settings.providers?.map(p => p.name) ?? [];
      const duplicate = providers.find((name, i) => providers.indexOf(name) !== i);
      if (duplicate) throw new Error(`lists the provider ${duplicate} twice`);
      const chosenHarness = harness || settings.harness;
      const chosenProvider = named || settings.provider;
      if (chosenHarness && !names.includes(chosenHarness)) throw new Error(`has no harness ${chosenHarness}`);
      const provider = chosenProvider ? settings.providers?.find(p => p.name === chosenProvider) : undefined;
      if (chosenProvider && !provider) throw new Error(`has no provider ${chosenProvider}`);
      const rank = (name: string) => (provider?.harnesses.indexOf(name) ?? -1) >>> 0;
      const harnesses = settings.harnesses.toSorted((a, b) => rank(a.name) - rank(b.name));
      return {
        ...settings,
        harnesses,
        ...(chosenHarness && { harness: chosenHarness }),
        ...(chosenProvider && { provider: chosenProvider }),
      };
    },
    catch: e => new GraphError({ problems: [{ path, message: (e as Error).message }] }),
  });
});

export const readOverrides = Config.all({
  repo: Config.option(Config.String('AGENTGRAPH_REPO')),
  trust: Config.option(Config.String('AGENTGRAPH_TRUST')),
  image: Config.option(Config.String('AGENTGRAPH_IMAGE')),
}).pipe(
  Config.map(env => ({
    ...(Option.isSome(env.repo) && { repo: env.repo.value }),
    ...(Option.isSome(env.trust) && {
      trust: env.trust.value
        .split(',')
        .map(login => login.trim())
        .filter(Boolean),
    }),
    ...(Option.isSome(env.image) && { image: env.image.value }),
  }))
);

export const readConfiguredGraph = (
  dir: string,
  instance: Parameters<typeof getSettings>[1] = {},
  flags: Parameters<typeof getSettings>[3] = {}
) =>
  Effect.gen(function* () {
    const settings = yield* readHarnessSettings;
    const graph = yield* loadGraph(dir, settings.harnesses, settings.harness);
    const overrides = { ...(yield* Effect.orDie(readOverrides)), ...flags };
    const resolved = getSettings(graph, instance, undefined, overrides);
    return {
      ...graph,
      repo: resolved.repo,
      ...(resolved.trust !== undefined && { trust: resolved.trust }),
      ...(resolved.image !== undefined && { image: resolved.image }),
      limits: { ...graph.limits, parallel: resolved.parallel },
      workflows: Object.fromEntries(
        Object.entries(graph.workflows).map(([name, workflow]) => {
          const { base } = getSettings(graph, instance, workflow, overrides);
          return [name, { ...workflow, ...(base !== undefined && { base }) }];
        })
      ),
    } satisfies Graph;
  });

export const makeEnvProvider = (env?: Record<string, string>) =>
  ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });

export const makeHarnessConfigProvider = (
  choice: Partial<Record<'config' | 'provider' | 'harness', string | undefined>>,
  fallback = makeEnvProvider()
) => {
  const names = { config: 'AGENTGRAPH_CONFIG', provider: 'AGENTGRAPH_PROVIDER', harness: 'AGENTGRAPH_HARNESS' };
  const chosen = Object.entries(choice).flatMap(([k, v]) => (v ? [[names[k as keyof typeof names], v] as const] : []));
  return ConfigProvider.fromEnv({ env: Object.fromEntries(chosen) }).pipe(ConfigProvider.orElse(fallback));
};

const inputFile = '.agentgraph/input';

/** Runs the harness on its input file, with its errors on the one stream it prints to, so the lines keep their order. */
const wrapped = (cmd: string, args: string[]) => ({
  cmd: 'sh',
  args: ['-c', `exec "$@" < "$HOME/${inputFile}" 2>&1`, 'sh', cmd, ...args],
});

/** `name=value` pairs, separated by commas or white space. */
export const parseNamePairs = (text: string) =>
  Object.fromEntries(
    splitNames(text).map(pair => {
      const at = pair.indexOf('=');
      if (at <= 0) throw new Error(`invalid name=value pair: ${pair}`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    })
  );

export const splitNames = (text: string) => text.split(/[\s,]+/).filter(Boolean);

export const parseModelUrls = (url: string): Record<string, string> =>
  /^[\w*-]+=/.test(url) ? parseNamePairs(url) : { '*': url };

/** The usage at the list price of the session's model; a model the table lacks is marked `unpriced`, keeping what the harness reported. */
const priced = (prices: Prices, models: string[], u: Extract<Piece, { type: 'usage' }>) => {
  const [cacheRead, cacheWrite] = [u.cacheRead ?? 0, u.cacheWrite ?? 0];
  const usd = getListPriceUsd(prices, models, {
    input: u.input - cacheRead - cacheWrite,
    cacheRead,
    cacheWrite,
    output: u.output,
  });
  return usd === undefined ? { ...u, unpriced: models[0] ?? 'unknown' } : { ...u, usd };
};

const makeHomePath = async (home: string, path: string) => {
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..'))
    throw new Error(`${path} is not a path inside the home`);
  let dir = home;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    if (!(await lstat(dir)).isDirectory()) throw new Error(`${dir} is not a directory`);
  }
  return join(dir, parts.at(-1)!);
};

const linkHome = async (home: string, path: string, target: string) => {
  const at = await makeHomePath(home, path);
  await rm(at, { recursive: true, force: true });
  await symlink(target, at);
};

/** Writes `text` to `path` under `home` without following a link the sandbox may have left in the home. */
const writeHome = async (home: string, path: string, text: string) => {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = constants;
  const file = await openFile(await makeHomePath(home, path), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW);
  await file.writeFile(text).finally(() => file.close());
};

const makeSessionStop = (e: SandboxError) =>
  new SessionStop({ reason: e.reason === 'infra' || e.reason === 'host' ? 'sandbox' : e.reason, detail: e.detail });

/**
 * Runs the harness of `harnesses` that `spec.harness` names. Each session gets its own home under
 * `data/homes`, reused on resume, its harness's URL from `proxy.url`, its agent's key from `proxy.keys` (`*` for any
 * agent) and the `passed` variables. Without a URL the harness uses its own endpoint, without a key its own login.
 * Usage is priced at list price from the `prices` table, and without one is unpriced.
 */
export const harnessSession = (
  s: {
    data: string;
    proxy: { url: string; keys: Redacted.Redacted; models?: string };
    passed?: Record<string, Redacted.Redacted>;
    prices?: string;
  } & Pick<HarnessSettings, 'harnesses' | 'providers' | 'provider'>
): Layer.Layer<Session, never, Sandbox> =>
  Layer.effect(
    Session,
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      const keys = parseNamePairs(Redacted.value(s.proxy.keys));
      const urls = parseModelUrls(s.proxy.url);
      const models = parseNamePairs(s.proxy.models ?? '');
      const prices = s.prices
        ? yield* Effect.try(() => readPrices(s.prices)).pipe(Effect.orDie)
        : { table: {}, aliases: {} };

      const open = (spec: SessionSpec) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const harness = s.harnesses.find(h => h.name === spec.harness);
            if (!harness)
              return yield* new SessionStop({ reason: 'sandbox', detail: `no harness ${spec.harness} in the config` });
            const classes = spec.tools.map(tool => harness.classify?.(tool));
            if (classes.some(value => value !== 'read' && value !== 'write'))
              return yield* new SessionStop({
                reason: 'sandbox',
                detail: `harness ${harness.name} cannot classify a tool`,
              });
            const named = (spec.model && models[spec.model]) ?? spec.model ?? models['*'] ?? 'default';
            const auth = s.providers?.find(provider => provider.name === s.provider)?.auth;
            const route = { url: urls[harness.name] ?? urls['*'] ?? '', model: named, ...(auth && { auth }) };
            const key = keys[spec.agent] ?? keys['*'] ?? (route.url && 'none');
            const secrets = {
              ...s.passed,
              ...(spec.mcp && { AGENTGRAPH_TOOL_SECRET: Redacted.make(spec.mcp.secret) }),
              ...(key && { [harness.key]: Redacted.make(key) }),
            };
            const {
              home: { files = {}, links = {} },
              command: { cmd, args, env = {}, readonly, input },
            } = yield* Effect.try({
              try: () => ({ home: harness.home?.(spec, route) ?? {}, command: harness.command(spec, route) }),
              catch: e => new SessionStop({ reason: 'sandbox', detail: `harness ${harness.name}: ${String(e)}` }),
            });
            const homes = join(s.data, 'homes');
            const from = spec.resume && join(homes, basename(spec.resume.home));
            const home = (!spec.fork && from) || join(homes, randomUUID());
            yield* Effect.tryPromise({
              try: async () => {
                const dir = from && (await lstat(from).catch(() => undefined))?.isDirectory();
                if (from && (dirname(resolve(from)) !== resolve(homes) || !dir))
                  throw new Error(`${spec.resume!.home} is not a session home in ${homes}`);
                if (spec.fork && from) await cp(from, home, { recursive: true, verbatimSymlinks: true });
                await mkdir(home, { recursive: true });
                for (const [path, text] of Object.entries({ ...files, [inputFile]: input }))
                  if (text === null) await rm(await makeHomePath(home, path), { force: true });
                  else await writeHome(home, path, text);
                for (const [path, target] of Object.entries(links)) await linkHome(home, path, target);
              },
              catch: e => new SessionStop({ reason: 'sandbox', detail: `run home: ${(e as Error).message}` }),
            });
            const hidden = Object.values(secrets)
              .map(secret => Redacted.value(secret))
              .flatMap(secret => [secret, ...secret.split(/[\n"]/)])
              .flatMap(secret => (secret.length < 8 ? [] : [JSON.stringify(secret).slice(1, -1), secret]));
            const parse = harness.parse();
            let session: string | undefined;
            let model = route.model;
            let reply = '';
            let done: Extract<Piece, { type: 'done' }> | undefined;
            let tail = '';

            const step = (raw: string | Pick<Exit, 'code' | 'used'>): SessionEvent[] => {
              if (typeof raw !== 'string') {
                const ended = done?.ended ?? 'error';
                const final = reply || (ended === 'error' ? (done?.error ?? tail.trim()) : '');
                return [
                  {
                    type: 'end',
                    final,
                    ended,
                    exit: raw.code,
                    ...(raw.used && { used: raw.used }),
                    ...(ended === 'error' && s.provider && { provider: s.provider }),
                  },
                ];
              }
              const line = formatRedactedText(raw, hidden);
              let json: unknown;
              try {
                json = JSON.parse(line);
              } catch {
                if (line.trim()) tail = (tail + '\n' + line).slice(-2000);
                return [];
              }
              return parse(json).flatMap((piece): SessionEvent[] => {
                if (piece.type === 'session') {
                  if (session) return [];
                  session = piece.id;
                  model = piece.model ?? model;
                  return [
                    {
                      type: 'start',
                      session: piece.id,
                      harness: harness.name,
                      ...(s.provider && { provider: s.provider }),
                      model: route.model,
                      home,
                    },
                  ];
                }
                if (piece.type === 'done') {
                  done = piece;
                  return [];
                }
                if (piece.type === 'text') reply += piece.text;
                if (piece.type === 'tool') {
                  reply = '';
                  if (
                    piece.ok !== false &&
                    !piece.denied &&
                    spec.mcp?.tools.some(name => piece.name === `mcp__tools__${name}` || piece.name === `tools_${name}`)
                  )
                    return [];
                }
                if (piece.type === 'usage') return [priced(prices, [piece.model ?? model, model, route.model], piece)];
                return [piece];
              });
            };

            return sandbox
              .lines({
                ...wrapped(cmd, args),
                dir: spec.dir,
                home,
                readonly: !!readonly || classes.every(value => value === 'read'),
                env: {
                  ...env,
                  ...(spec.base && { AGENTGRAPH_BASE: spec.base }),
                  ...(spec.mcp && { AGENTGRAPH_TOOL_URL: spec.mcp.url }),
                },
                secrets,
                ...(spec.mcp && { tools: { url: spec.mcp.url, host: spec.mcp.host } }),
                network: 'proxy',
                minutes: spec.minutes,
                ...(spec.limits && { limits: spec.limits }),
              })
              .pipe(Stream.mapError(makeSessionStop), Stream.map(step), Stream.flattenIterable);
          })
        );

      return { open };
    })
  );
