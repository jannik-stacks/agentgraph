#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

// UNEXPECTED: BusyBox env has no -S, so the shebang cannot pass --disable-warning; this drops the same warnings.
const [print] = process.listeners('warning');
if (print) process.off('warning', print).on('warning', w => w.name === 'ExperimentalWarning' || print(w));

registerHooks({
  load: (url, context, next) =>
    url.startsWith('file:') && url.endsWith('.ts')
      ? { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')), shortCircuit: true }
      : next(url, context),
});
await import('./run.ts');
