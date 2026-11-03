import { type ChildProcess, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';

const replaced = new WeakSet<ChildProcess>();
const serve = () => {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'dev.ts'), ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  child.on('exit', code => {
    if (!replaced.has(child)) process.exit(code ?? 1);
  });
  return child;
};

let server = serve();
let timer: NodeJS.Timeout | undefined;

const restart = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log('studio   engine code changed, restarting');
    const next = () => (server = serve());
    replaced.add(server);
    if (server.exitCode !== null || server.signalCode !== null) return void next();
    server.once('exit', next);
    server.kill();
  }, 100);
};
for (const dir of ['src', 'bin']) watch(join(import.meta.dirname, '..', dir), { recursive: true }, restart);
