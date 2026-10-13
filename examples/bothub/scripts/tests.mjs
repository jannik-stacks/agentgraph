// Runs vitest on the arguments given and prints one line when it passes. When it fails, the failing tests come
// first, by file and full name with the first line of their error, then the end of vitest's error log and its
// summary, so a long error log never pushes the names out of the part of the output that is kept. A run whose output
// reports a module that could not load fails too, listing those lines, even when every test passed: a test over a
// module that did not load tests nothing. A pass names each criterion test of the triage brief that was skipped.
//
//   node tests.mjs [file...]      e.g. node tests.mjs tests/live.test.ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { findBrief, parseBrief } from './brief.mjs';

const kept = 7000;
const listed = 40;
const loadError = /could not load|PARSE_ERROR|Failed to load/;
const line = text => (text ?? '').split('\n').find(Boolean)?.slice(0, 200) ?? '';

const tmp = mkdtempSync(join(tmpdir(), 'bothub-tests-'));
const { FORCE_COLOR: _, ...rest } = process.env;
const env = { ...rest, NO_COLOR: '1', HOME: process.env.HOME || tmp };
try {
  const out = join(tmp, 'result.json');
  const run = spawnSync(
    'node_modules/.bin/vitest',
    ['run', '--reporter=dot', '--reporter=json', `--outputFile.json=${out}`, ...process.argv.slice(2)],
    { encoding: 'utf8', timeout: 10 * 60_000, env }
  );
  const result = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
  const loads = [
    ...new Set(
      `${run.stdout}\n${run.stderr}`
        .split('\n')
        .filter(text => loadError.test(text))
        .map(text => text.trim().slice(0, 200))
    ),
  ];
  if (run.status === 0 && loads.length) {
    console.log([...loads.slice(0, listed), `tests: ${result?.numPassedTests ?? 'all'} passed, but the output reports a module that could not load`].join('\n'));
    process.exitCode = 1;
  } else if (run.status === 0) {
    const brief = findBrief();
    const titles = new Set(brief ? parseBrief(brief).criteria.map(c => c.title) : []);
    const skipped = (result?.testResults ?? []).flatMap(file =>
      file.assertionResults.filter(test => titles.has(test.title) && test.status !== 'passed').map(test => `'${test.title}'`)
    );
    console.log(`tests: ${result?.numPassedTests ?? 'all'} passed${skipped.length ? `; criterion tests skipped: ${skipped.join(', ')}` : ''}`);
  }
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
