import { type ChildProcess, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';

const serve = () =>
  spawn(process.execPath, [join(import.meta.dirname, 'dev.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });

let server: ChildProcess = serve();
let edited = false;
let timer: NodeJS.Timeout | undefined;
server.on('exit', code => {
  if (!edited) process.exit(code ?? 1);
});

const restart = () => {
  edited = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log('studio   engine code changed, restarting');
    const next = () => (server = serve());
    if (server.exitCode !== null || server.signalCode !== null) return void next();
    server.once('exit', next);
    server.kill();
  }, 100);
};
for (const dir of ['src', 'bin']) watch(join(import.meta.dirname, '..', dir), { recursive: true }, restart);
