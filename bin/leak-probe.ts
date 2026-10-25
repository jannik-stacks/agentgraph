import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const canary = process.env.PROBE_CANARY;
const secret = new RegExp(
  [
    'sk-[\\w-]{16,}',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'gh[pousr]_\\w{30,}',
    'github_pat_\\w{20,}',
    ...(canary ? [canary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] : []),
  ].join('|')
);
const named = /(^|_)(KEYS?|TOKEN|SECRET|PASSWORD|PEM)$/;
const repo = fileURLToPath(new URL('..', import.meta.url));
const skipped = new Set(['node_modules', '.git', 'dist', 'coverage', 'mirror.git', 'homes']);

const readOutput = (cmd: string, args: string[]) => {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT'].flatMap(k => (process.env[k] ? [[k, process.env[k]]] : []))
  );
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 1 << 28, timeout: 30_000 });
  return r.status === 0 ? r.stdout : '';
};

const isSecretVariable = (name: string, value: string) =>
  !name.startsWith('PROBE_') && (secret.test(value) || (named.test(name) && value.length >= 8));

const findFiles = (path: string, depth = 0): string[] => {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return stat.size < 1 << 20 ? [path] : [];
  if (!stat.isDirectory() || depth > 8) return [];
  return readdirSync(path)
    .filter(name => !skipped.has(name))
    .flatMap(name => findFiles(join(path, name), depth + 1));
};

const roots = process.env.PROBE_PATHS
  ? process.env.PROBE_PATHS.split(':').filter(Boolean)
  : [
      ...readOutput('git', ['-C', repo, 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'])
        .split('\0')
        .filter(path => path && !path.split('/').some(part => skipped.has(part)))
        .map(path => join(repo, path)),
      join(homedir(), '.agentgraph'),
      join(homedir(), '.config', 'agentgraph'),
    ];

const findSecretFiles = () =>
  roots.flatMap(root =>
    findFiles(resolve(root)).filter(file => {
      try {
        return secret.test(readFileSync(file, 'utf8'));
      } catch {
        return false;
      }
    })
  );

const probes: Record<string, () => Promise<string[]> | string[]> = {
  env: () =>
    Object.entries(process.env).flatMap(([name, value]) =>
      isSecretVariable(name, value ?? '') ? [`env ${name}`] : []
    ),
  files: () => findSecretFiles().map(file => `file ${file}`),
  ps: () =>
    readOutput('ps', ['axeww', '-o', 'pid=,command='])
      .split('\n')
      .flatMap(line => {
        const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
        return pid && pid !== String(process.pid) && secret.test(command!) ? [`ps ${pid}`] : [];
      }),
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
        return ((JSON.parse(env) as string[] | null) ?? []).flatMap(pair => {
          const at = pair.indexOf('=');
          return isSecretVariable(pair.slice(0, at), pair.slice(at + 1)) ? [`docker ${name} ${pair.slice(0, at)}`] : [];
        });
      }),
  studio: async () => {
    const studio = process.env.PROBE_STUDIO ?? 'http://127.0.0.1:5182';
    const served = await Promise.all(
      findSecretFiles().map(async file => {
        const res = await fetch(`${studio}/@fs${file}`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
        return res?.ok && secret.test(await res.text()) ? [`studio ${file}`] : [];
      })
    );
    return served.flat();
  },
};

const asked = process.argv.slice(2);
if (asked.some(name => !(name in probes))) {
  console.error(`usage: node bin/leak-probe.ts [${Object.keys(probes).join('] [')}]`);
  process.exit(2);
}
const hits = (await Promise.all((asked.length ? asked : Object.keys(probes)).map(name => probes[name]!()))).flat();
for (const hit of hits) console.log(hit);
console.log(hits.length ? `${hits.length} hit(s)` : 'no hits');
process.exit(hits.length ? 1 : 0);
