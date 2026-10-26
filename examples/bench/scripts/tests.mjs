import { execFileSync, spawnSync } from 'node:child_process';

const test = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_test\.\w+$/;
const [mode, file] = process.argv.slice(2);

if (mode === 'list') {
  const changed = execFileSync('git', ['diff', '--name-only', '--relative', process.env.AGENTGRAPH_BASE ?? 'HEAD'], {
    encoding: 'utf8',
  });
  for (const path of changed.split('\n').filter(path => test.test(path) && !path.endsWith('.snap'))) console.log(path);
} else {
  const ran = spawnSync('npm', ['test', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`${ran.stdout}${ran.stderr}`.trim().split('\n').slice(-30).join('\n'));
  process.exit(ran.status ?? 1);
}
