// Runs vitest on the arguments given and prints one line when it passes. When it fails, the failing tests come
// first, by file and full name with the first line of their error, then the end of vitest's error log and its
// summary, so a long error log never pushes the names out of the part of the output that is kept. With
// `--load-errors` it instead lists the lines of the suite's output that report a module that could not load, which
// a loader can print while every test still passes.
//
//   node tests.mjs [--load-errors] [file...]      e.g. node tests.mjs tests/live.test.ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { report } from './changes.mjs';

const kept = 7000;
const listed = 40;
const loadError = /could not load|PARSE_ERROR|Failed to load/;
const args = process.argv.slice(2);
const loads = args.includes('--load-errors');
const line = text => (text ?? '').split('\n').find(Boolean)?.slice(0, 200) ?? '';

const tmp = mkdtempSync(join(tmpdir(), 'bothub-tests-'));
const { FORCE_COLOR: _, ...rest } = process.env;
const env = { ...rest, NO_COLOR: '1', HOME: process.env.HOME || tmp };
try {
  const out = join(tmp, 'result.json');
  const run = spawnSync(
    'node_modules/.bin/vitest',
    ['run', '--reporter=dot', '--reporter=json', `--outputFile.json=${out}`, ...args.filter(arg => arg !== '--load-errors')],
    { encoding: 'utf8', timeout: 10 * 60_000, env }
  );
  const result = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
  if (loads) {
    const lines = `${run.stdout}\n${run.stderr}`.split('\n').filter(text => loadError.test(text));
    report('load-errors', [...new Set(lines.map(text => text.trim().slice(0, 200)))].slice(0, listed));
  } else if (run.status === 0) console.log(`tests: ${result?.numPassedTests ?? 'all'} passed`);
  else {
    const failed = (result?.testResults ?? []).flatMap(file =>
      file.assertionResults
        .filter(test => test.status === 'failed')
        .map(test => `FAIL ${relative(process.cwd(), file.name)} > ${test.fullName}: ${line(test.failureMessages?.[0])}`)
    );
    const broken = (result?.testResults ?? [])
      .filter(file => file.status === 'failed' && !file.assertionResults.some(test => test.status === 'failed'))
      .map(file => `FAIL ${relative(process.cwd(), file.name)}: ${line(file.message)}`);
    const names = [...broken, ...failed];
    const head = [
      ...names.slice(0, listed),
      ...(names.length > listed ? [`and ${names.length - listed} more`] : []),
    ].join('\n');
    const summary = (run.stdout ?? '')
      .trim()
      .split('\n')
      .filter(text => !text.startsWith('JSON report written'))
      .slice(-8)
      .join('\n');
    const log = (run.stderr ?? '').trim();
    const room = Math.max(1000, kept - head.length - summary.length);
    const tail = log.length > room ? log.slice(log.indexOf('\n', log.length - room) + 1) : log;
    console.log([head, tail, summary, `tests: ${names.length || 'the run'} failed`].filter(Boolean).join('\n\n'));
    process.exitCode = 1;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
