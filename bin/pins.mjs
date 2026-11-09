import { execFileSync } from 'node:child_process';
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    set: { type: 'string', multiple: true, default: [] },
    root: { type: 'string', default: join(import.meta.dirname, '..') },
  },
});
const dockerfiles = globSync('infra/local/**/Dockerfile', { cwd: values.root }).map(f => join(values.root, f));

for (const pair of values.set) {
  const [, name, version] = /^(\w+_VERSION)=(\d+\.\d+\.\d+)$/.exec(pair) ?? [];
  if (!name) throw new Error(`${pair}: write a pin as NAME_VERSION=x.y.z`);
  const line = new RegExp(`^ARG ${name}=\\S*$`, 'm');
  const files = dockerfiles.filter(file => line.test(readFileSync(file, 'utf8')));
  if (!files.length) throw new Error(`no Dockerfile under infra/local has ARG ${name}`);
  for (const file of files) writeFileSync(file, readFileSync(file, 'utf8').replace(line, `ARG ${name}=${version}`));
  console.log(`${name}=${version} in ${files.join(', ')}`);
}

if (!values.set.length)
  for (const file of dockerfiles.toSorted()) {
    const text = readFileSync(file, 'utf8');
    const args = Object.fromEntries([...text.matchAll(/^ARG (\w+_VERSION)=(\S*)$/gm)].map(m => [m[1], m[2]]));
    const packages = new Map([...text.matchAll(/(\S+)@\$\{(\w+)\}/g)].map(m => [m[1], m[2]]));
    for (const [pkg, name] of packages) {
      const latest = execFileSync('npm', ['view', pkg, 'version'], { encoding: 'utf8' }).trim();
      console.log([pkg, `${name}=${args[name]}`, `latest ${latest}`].join('  '));
    }
  }
