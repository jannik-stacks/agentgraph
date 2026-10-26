import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const canary = process.env.PROBE_CANARY;
const secret = [
  '(?<![\\w-])sk-(?=[\\w-]*\\d)[\\w-]{20,}',
  '\\bgh[pousr]_[A-Za-z0-9]{30,}',
  '\\bgithub_pat_\\w{22,}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?:\\s|\\\\n)+[\\w-]+:[^\\n\\\\]*)*(?:\\s|\\\\n)+[A-Za-z0-9+/]{40}',
  '\\bAKIA[0-9A-Z]{16}\\b',
  '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
  ...(canary ? [canary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] : []),
].join('|');
const named = /(^|_)(KEYS?|TOKEN|SECRET|PASSWORD|PEM)(_|$)/;
const repo = fileURLToPath(new URL('..', import.meta.url));
const skipped = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  'coverage',
  'mirror.git',
  'homes',
]);
const skippedFile = /\.example$|\.(test|spec)\.\w+$/;

const readOutput = (cmd: string, args: string[]) => {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT'].flatMap(k => (process.env[k] ? [[k, process.env[k]]] : []))
  );
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 1 << 28, timeout: 30_000 });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args[0]} failed: ${r.error?.message ?? r.stderr.trim().split('\n')[0]}`);
  return r.stdout;
};

const countSecrets = (text: string) => text.match(new RegExp(secret, 'g'))?.length ?? 0;

const isSecretVariable = (name: string, value: string) =>
  !name.startsWith('PROBE_') &&
  (countSecrets(value) > 0 || (named.test(name) && value.length >= 8 && !/^[~/.]/.test(value)));

const findFiles = (path: string, depth = 0): string[] => {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return stat.size < 8 << 20 && !skippedFile.test(path) ? [path] : [];
  if (!stat.isDirectory() || depth > 8) return [];
  return readdirSync(path)
    .filter(name => !skipped.has(name))
    .flatMap(name => findFiles(join(path, name), depth + 1));
};

const findRoots = () =>
  process.env.PROBE_PATHS
    ? process.env.PROBE_PATHS.split(':').filter(Boolean)
    : [
        ...readOutput('git', ['-C', repo, 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'])
          .split('\0')
          .filter(path => path && !path.split('/').some(part => skipped.has(part)))
          .map(path => join(repo, path)),
        join(homedir(), '.agentgraph'),
        join(homedir(), '.config', 'agentgraph'),
      ];

const readText = (file: string) => {
  try {
    const bytes = readFileSync(file);
    return bytes.includes(0) ? '' : bytes.toString('utf8');
  } catch {
    return '';
  }
};

let secretFiles: { file: string; count: number }[] | undefined;
const findSecretFiles = () =>
  (secretFiles ??= findRoots().flatMap(root =>
    findFiles(resolve(root)).flatMap(file => {
      const count = countSecrets(readText(file));
      return count ? [{ file, count }] : [];
    })
  ));

const isKeyAtRest = (file: string) =>
  ['.env', '.keys.env', '.keys.env.local'].map(name => join(repo, 'infra/local', name)).includes(file) ||
  (file.startsWith(join(homedir(), '.config', 'agentgraph') + '/') && basename(file) === 'key.pem');

const listProcesses = (args: string[]) =>
  new Map(
    readOutput('ps', args)
      .split('\n')
      .flatMap(line => {
        const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
        return pid && pid !== String(process.pid) ? [[pid, command!] as const] : [];
      })
  );

const groupBy = <T>(list: T[], getKey: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of list) {
    const key = getKey(item);
    groups
      .set(key, groups.get(key) ?? [])
      .get(key)!
      .push(item);
  }
  return [...groups];
};

type Hit = { place: string; detail: string; expected?: boolean };

const probes: Record<string, () => Promise<Hit[]> | Hit[]> = {
  env: () =>
    Object.entries(process.env).flatMap(([name, value]) =>
      isSecretVariable(name, value ?? '') ? [{ place: 'env', detail: name }] : []
    ),
  files: () =>
    findSecretFiles().map(({ file, count }) => ({
      place: 'file',
      detail: `${file}  ${count} key(s)`,
      expected: isKeyAtRest(file),
    })),
  ps: () => {
    const argv = listProcesses(['axww', '-o', 'pid=,command=']);
    const programs = listProcesses(['axww', '-o', 'pid=,comm=']);
    const found = [...listProcesses(['axeww', '-o', 'pid=,command='])].flatMap(([pid, all]) => {
      const args = argv.get(pid) ?? '';
      const env = all.startsWith(args) ? all.slice(args.length) : all;
      const names = [
        ...(countSecrets(args) ? ['argv'] : []),
        ...[...env.matchAll(/(?:^|\s)([A-Za-z_]\w*)=(.*?)(?=\s[A-Za-z_]\w*=|$)/g)].flatMap(([, name, value]) =>
          isSecretVariable(name!, value!) ? [name!] : []
        ),
      ];
      const command = [
        programs.get(pid) ?? '',
        args.split(/\s+/).find(arg => /^[\w./-]+\.([cm]?[jt]s|py|sh|rb)$/.test(arg)) ?? '',
      ]
        .map(part => basename(part))
        .join(' ');
      return names.length ? [{ pid, what: `${command.trim()}  ${names.join(' ')}` }] : [];
    });
    return groupBy(found, hit => hit.what).map(([what, group]) => ({
      place: 'ps',
      detail: `${group.map(hit => hit.pid).join(',')} ${what}`,
    }));
  },
  docker: () =>
    readOutput('docker', ['ps', '-q'])
      .split('\n')
      .filter(Boolean)
      .flatMap(id => {
        const [name = id, env = 'null'] = readOutput('docker', [
          'inspect',
          '--format',
          '{{.Name}}\t{{json .Config.Env}}',
          id,
        ]).split('\t');
        const names = ((JSON.parse(env) as string[] | null) ?? []).flatMap(pair => {
          const at = pair.indexOf('=');
          return isSecretVariable(pair.slice(0, at), pair.slice(at + 1)) ? [pair.slice(0, at)] : [];
        });
        return names.length
          ? [
              {
                place: 'docker',
                detail: `${name}  ${names.join(' ')}`,
                expected: /^\/\w+-(litellm|postgres)(-\d+)?$/.test(name),
              },
            ]
          : [];
      }),
  studio: async () => {
    const studio = process.env.PROBE_STUDIO ?? 'http://127.0.0.1:5182';
    const served = await Promise.all(
      findSecretFiles().map(async ({ file }) => {
        const res = await fetch(`${studio}/@fs${file}`, { signal: AbortSignal.timeout(3000) }).catch(() => {
          throw new Error('no answer from the studio');
        });
        return res.ok && countSecrets(await res.text()) ? [{ place: 'studio', detail: file }] : [];
      })
    );
    return served.flat();
  },
};

const asked = process.argv.slice(2);
if (asked.some(name => !Object.hasOwn(probes, name))) {
  console.error(`usage: node bin/leak-probe.ts [${Object.keys(probes).join('] [')}]`);
  process.exit(2);
}
const skips: string[] = [];
const hits = (
  await Promise.all(
    (asked.length ? asked : Object.keys(probes)).map(async name => {
      try {
        return await probes[name]!();
      } catch (e) {
        skips.push(`skip ${name}: ${(e as Error).message.replace(new RegExp(secret, 'g'), '[key]')}`);
        return [];
      }
    })
  )
).flat();

const tally = (list: Hit[]) =>
  groupBy(list, hit => hit.place)
    .map(([place, group]) => `${group.length} ${place}`)
    .join(', ');
const look = hits.filter(hit => !hit.expected);
const expected = hits.filter(hit => hit.expected);
for (const [title, list] of [
  ['look at this', look],
  ['expected', expected],
] as const)
  if (list.length) console.log([title, ...list.map(hit => `  ${hit.place} ${hit.detail}`)].join('\n'));
for (const line of skips) console.log(line);
console.log(
  [
    look.length
      ? `look at ${look.length}: ${tally(look)}`
      : skips.length
        ? 'nothing to look at, but not every probe ran'
        : 'nothing to look at',
    ...(expected.length ? [`expected ${expected.length}: ${tally(expected)}`] : []),
  ].join('; ')
);
process.exit(look.length ? 1 : skips.length ? 3 : 0);
