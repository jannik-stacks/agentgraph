import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open as openFile, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Config, Effect, Layer, Redacted, Stream } from 'effect';
import { type HarnessCheck, HubError, loadHub } from './hub.ts';
import { type Exit, Sandbox, type SandboxError } from './sandbox.ts';
import { Session } from './session.ts';
import { type SessionEvent, type SessionSpec, SessionStop } from './trace.ts';

export type Piece =
  | { type: 'session'; id: string; model?: string }
  | Extract<SessionEvent, { type: 'text' | 'thinking' | 'tool' | 'usage' }>
  | { type: 'done'; ended: Extract<SessionEvent, { type: 'end' }>['ended']; error?: string };

type ModelRoute = { url: string; model: string };

export type Harness = HarnessCheck & {
  key: string;
  home?: (
    spec: Omit<SessionSpec, 'model'>,
    route: ModelRoute
  ) => { files?: Record<string, string>; links?: Record<string, string> };
  command: (
    spec: Omit<SessionSpec, 'model'>,
    route: ModelRoute
  ) => { cmd: string; args: string[]; env?: Record<string, string>; volumes?: Record<string, string> };
  parse: () => (line: unknown) => Piece[];
};

export type Provider = {
  name: string;
  harnesses: string[];
  ready: () => boolean | Promise<boolean>;
  detect?: () => boolean;
  settings?: () => Record<string, string>;
  login?: () => Promise<void>;
};

export type HarnessSettings = { harnesses: Harness[]; providers?: Provider[]; harness?: string };

const builtIn = fileURLToPath(new URL('../agentgraph.config.ts', import.meta.url));

export const readHarnessSettings = Effect.gen(function* () {
  const path = resolve(yield* Effect.orDie(Config.string('AGENTGRAPH_CONFIG').pipe(Config.withDefault(builtIn))));
  const harness = yield* Effect.orDie(Config.string('AGENTGRAPH_HARNESS').pipe(Config.withDefault('')));
  const named = yield* Effect.orDie(Config.string('AGENTGRAPH_PROVIDER').pipe(Config.withDefault('')));
  return yield* Effect.tryPromise({
    try: async () => {
      const settings: HarnessSettings | undefined = (await import(pathToFileURL(path).href)).default;
      if (!Array.isArray(settings?.harnesses)) throw new Error('has no default export with a harnesses list');
      const names = settings.harnesses.map(h => h.name);
      const twice = names.find((name, i) => names.indexOf(name) !== i);
      if (twice) throw new Error(`lists the harness ${twice} twice`);
      if (harness && !names.includes(harness)) throw new Error(`has no harness ${harness}`);
      const provider = named ? settings.providers?.find(p => p.name === named) : undefined;
      if (named && !provider) throw new Error(`has no provider ${named}`);
      const rank = (name: string) => (provider?.harnesses.indexOf(name) ?? -1) >>> 0;
      const harnesses = settings.harnesses.toSorted((a, b) => rank(a.name) - rank(b.name));
      return { ...settings, harnesses, ...(harness && { harness }) };
    },
    catch: e => new HubError({ problems: [{ path, message: (e as Error).message }] }),
  });
});

export const readConfiguredHub = (dir: string) =>
  Effect.flatMap(readHarnessSettings, settings => loadHub(dir, settings.harnesses, settings.harness));

/** Runs the harness with its errors on the one stream it prints to, so the lines keep their order. */
const wrapped = (cmd: string, args: string[]) => ({ cmd: 'sh', args: ['-c', 'exec "$@" 2>&1', 'sh', cmd, ...args] });

/** `name=value` pairs, separated by commas or white space. */
const pairsOf = (text: string) =>
  Object.fromEntries(
    splitNames(text).flatMap(pair => {
      const at = pair.indexOf('=');
      return at > 0 ? [[pair.slice(0, at), pair.slice(at + 1)]] : [];
    })
  );

export const splitNames = (text: string) => text.split(/[\s,]+/).filter(Boolean);

export const parseModelUrls = (url: string): Record<string, string> =>
  /^[\w*-]+=/.test(url) ? pairsOf(url) : { '*': url };

/**
 * List prices in USD per million tokens, keyed by upstream model, the proxy's aliases for them, and the upstream
 * prefixes a subscription pays for, whose list price is only an estimate.
 */
export type Prices = {
  aliases?: Record<string, string>;
  models?: Record<string, { input: number; output: number; cached?: number; cacheWrite?: number }>;
  subscriptions?: string[];
};

/** The list price of the first of `models` the table knows, by its own name, its alias's upstream or a bare name. */
export const getModelPrice = (prices: Prices, models: string[]) => {
  const bare = (model: string) => model.split('/').at(-1) ?? model;
  return models
    .flatMap(model => [model, prices.aliases?.[model] ?? model, prices.aliases?.[bare(model)] ?? model])
    .map(model => prices.models?.[model] ?? prices.models?.[bare(model)])
    .find(Boolean);
};

/** The usage's list price when the harness reports none, as a subscription through the proxy does; else what is unpriced. */
const priced = (prices: Prices, models: string[], u: Extract<Piece, { type: 'usage' }>) => {
  if (u.usd) return u;
  const price = getModelPrice(prices, models);
  if (!price) return { ...u, unpriced: models[0] ?? 'unknown' };
  const [read, write] = [u.cacheRead ?? 0, u.cacheWrite ?? 0];
  const usd =
    ((u.input - read - write) * price.input +
      read * (price.cached ?? price.input) +
      write * (price.cacheWrite ?? price.input) +
      u.output * price.output) /
    1e6;
  return { ...u, usd };
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

const stopOf = (e: SandboxError) =>
  new SessionStop({ reason: e.reason === 'infra' ? 'sandbox' : e.reason, detail: e.detail });

/**
 * Runs the harness of `harnesses` that `spec.harness` names. Each session gets its own home under
 * `data/homes`, reused on resume, its harness's URL from `proxy.url`, its agent's key from `proxy.keys` (`*` for any
 * agent) and the `passed` variables. Without a URL the harness uses its own endpoint, without a key its own login.
 * Usage the harness does not price is priced from the `prices` file.
 */
export const harnessSession = (s: {
  data: string;
  proxy: { url: string; keys: Redacted.Redacted; models?: string };
  passed?: Record<string, Redacted.Redacted>;
  prices?: string;
  harnesses: readonly Harness[];
}): Layer.Layer<Session, never, Sandbox> =>
  Layer.effect(
    Session,
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      const keys = pairsOf(Redacted.value(s.proxy.keys));
      const urls = parseModelUrls(s.proxy.url);
      const models = pairsOf(s.proxy.models ?? '');
      const prices: Prices = s.prices
        ? yield* Effect.tryPromise(() => readFile(s.prices!, 'utf8').then(JSON.parse)).pipe(Effect.orDie)
        : {};

      const open = (spec: SessionSpec) =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const harness = s.harnesses.find(h => h.name === spec.harness);
            if (!harness)
              return yield* new SessionStop({ reason: 'sandbox', detail: `no harness ${spec.harness} in the config` });
            const named = (spec.model && models[spec.model]) ?? spec.model ?? models['*'] ?? 'default';
            const route = { url: urls[harness.name] ?? urls['*'] ?? '', model: named };
            const key = keys[spec.agent] ?? keys['*'] ?? (route.url && 'none');
            const secrets = { ...s.passed, ...(key && { [harness.key]: Redacted.make(key) }) };
            const { files = {}, links = {} } = harness.home?.(spec, route) ?? {};
            const homes = join(s.data, 'homes');
            const home = (!spec.fork && spec.resume?.home) || join(homes, randomUUID());
            yield* Effect.tryPromise({
              try: async () => {
                const from = spec.resume?.home;
                if (from && (dirname(resolve(from)) !== resolve(homes) || !(await lstat(from)).isDirectory()))
                  throw new Error(`${from} is not a session home in ${homes}`);
                if (spec.fork && spec.resume)
                  await cp(spec.resume.home, home, { recursive: true, verbatimSymlinks: true });
                await mkdir(home, { recursive: true });
                for (const [path, text] of Object.entries(files)) await writeHome(home, path, text);
                for (const [path, target] of Object.entries(links)) await linkHome(home, path, target);
              },
              catch: e => new SessionStop({ reason: 'sandbox', detail: `run home: ${(e as Error).message}` }),
            });
            const { cmd, args, env = {}, volumes } = harness.command(spec, route);
            const hidden = Object.values(secrets)
              .map(secret => Redacted.value(secret))
              .flatMap(secret => [secret, ...secret.split('\n')])
              .flatMap(secret => (secret.length < 8 ? [] : [JSON.stringify(secret).slice(1, -1), secret]));
            const parse = harness.parse();
            let session: string | undefined;
            let model = route.model;
            let reply = '';
            let done: Extract<Piece, { type: 'done' }> | undefined;
            let tail = '';

            const step = (raw: string | Pick<Exit, 'code'>): SessionEvent[] => {
              if (typeof raw !== 'string') {
                const ended = done?.ended ?? 'error';
                const final = reply || (ended === 'error' ? (done?.error ?? tail.trim()) : '');
                return [{ type: 'end', final, ended, exit: raw.code }];
              }
              const line = hidden.reduce((text, secret) => text.replaceAll(secret, '***'), raw);
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
                  return [{ type: 'start', session: piece.id, model, home }];
                }
                if (piece.type === 'done') {
                  done = piece;
                  return [];
                }
                if (piece.type === 'text') reply += piece.text;
                if (piece.type === 'tool') reply = '';
                if (piece.type === 'usage') return [priced(prices, [model, route.model], piece)];
                return [piece];
              });
            };

            return sandbox
              .lines({
                ...wrapped(cmd, args),
                dir: spec.dir,
                home,
                env: { ...env, ...(spec.base && { AGENTGRAPH_BASE: spec.base }) },
                secrets,
                ...(volumes && { volumes }),
                network: 'proxy',
                minutes: spec.minutes,
              })
              .pipe(Stream.mapError(stopOf), Stream.mapConcat(step));
          })
        );

      return { open };
    })
  );
