import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../src/config.ts';
import { readHub } from '../src/load.ts';
import { localIssues } from '../src/issues-local.ts';
import { callTool, McpTool } from '../src/mcp.ts';
import { buildSpec, runPlanned } from '../src/pipeline.ts';
import { issueContext } from '../src/preload.ts';
import { index, issueDocs, noteDocs } from '../src/recall.ts';
import { limiter, unsandboxed } from '../src/runner.ts';
import { openStore } from '../src/store.ts';
import type { AgentEvent, BotEvent, HarnessAdapter, RunSpec } from '../src/types.ts';
import { workspaces } from '../src/workspace.ts';
import { sourceRepo, temp } from './git.ts';

const marker = 'HUMAN-MARKER-7f3a';
const map = (kind: string) => `human: { source: "${marker} ${kind}", other: "${marker} extra" }`;
const plain = (kind: string) => `human: "${marker} ${kind}"`;

const files: Record<string, string> = {
  'hub.yaml': `issues: local\n${plain('hub')}\n`,
  'bots/worker.md': `---\nharness: opencode\ntools: [read, issues_get, issues_list, notes_search, notes_get]\nreturns: [reply, note]\npreload: [issue, links, recall]\nskills: [work, judge]\n${map('bot')}\n---\n\nYou work.\n`,
  'bots/judge.md': `---\nharness: opencode\ntools: [read, notes_search]\nreturns: [reply]\npreload: [issue, recall]\n${map('judge bot')}\n---\n\nYou judge.\n`,
  'skills/work.md': `---\ndescription: Change code.\n${plain('skill')}\n---\n\nImplement it.\n`,
  'skills/judge.md': `---\ndescription: Judge a change.\n${map('judge skill')}\n---\n\nJudge it.\n`,
  'checks/judged.md': `---\ntype: bot\nbot: judge\nskill: judge\nover: diff\nmode: warn\n${map('bot check')}\n---\n\nIs the change small?\n`,
  'checks/asked.md': `---\ntype: decide\nover: diff\n${plain('decide check')}\n---\n\nIs this change free of secrets?\n`,
  'checks/ran.md': `---\ntype: script\nrun: "true"\n${map('script check')}\n---\n`,
  'workflows/w.md': `---\non: { issue_comment: {} }\njobs:\n  loop:\n    type: bot\n    bot: worker\n    skill: work\n    returns: [reply]\n    until: { checks: [judged, asked, ran], max: 1 }\n    ${plain('job')}\n${map('workflow')}\n---\n\nA workflow.\n`,
  'notes/style/small.md': `---\ntitle: Small changes\n${map('note')}\n---\n\nKeep changes small.\n`,
  'notes/caveat/limits.md': `---\ntitle: Limits\nstatus: accepted\n${plain('caveat')}\n---\n\nKeep budgets short.\n`,
};

const issueFiles: Record<string, string> = {
  '7-task.md': `---\ntitle: Task\nlinks: [8]\n${map('issue')}\n---\n\nDo the small change.\n`,
  '8-other.md': `---\ntitle: Other\nparent: 7\n${plain('linked issue')}\n---\n\nRelated.\n`,
};

const event: BotEvent = {
  id: 'd1',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'local',
  trigger: 'issue_comment',
  action: 'created',
  repo: 'acme/app',
  number: 7,
  actor: { login: 'octocat', association: 'OWNER' },
  body: 'please make the small change',
};

const hub = async () => {
  const dir = temp('human-hub');
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  const issuesDir = join(dir, 'issues');
  mkdirSync(issuesDir);
  for (const [name, source] of Object.entries(issueFiles)) writeFileSync(join(issuesDir, name), source);
  const compiled = compile(await readHub(dir));
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return { dir, config: compiled.config, issues: localIssues(issuesDir, { repo: 'acme/app' }) };
};

const final = (body: string) => ['Done.', '```bothub', JSON.stringify([{ kind: 'reply', body }]), '```'].join('\n');

/** An adapter that records each spec; the worker writes a file, the judge passes. */
const recording = () => {
  const seen: RunSpec[] = [];
  const adapter: HarnessAdapter = {
    name: 'opencode',
    command: spec => {
      seen.push(spec);
      const judge = spec.system.startsWith('You judge.');
      const work = judge ? '' : "fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/a.ts', 'a\\n');";
      const events: AgentEvent[] = [
        { type: 'start', session: 's', model: 'm' },
        { type: 'end', ok: true, turns: 1, result: final(judge ? 'PASS' : 'done') },
      ];
      const out = events.map(e => JSON.stringify(e)).join('\n');
      return {
        cmd: 'node',
        args: ['-e', `const fs = require('fs'); ${work} console.log(${JSON.stringify(out)})`],
        env: {},
      };
    },
    parseLine: line => (line.trim() ? [JSON.parse(line) as AgentEvent] : []),
  };
  return { seen, adapters: { opencode: adapter, pi: { ...adapter, name: 'pi' as const } } };
};

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

afterEach(() => vi.unstubAllGlobals());

describe('human', () => {
  it('compiles on every kind, so the config holds what the leak checks look for', async () => {
    const { config } = await hub();
    expect(text(config)).toContain(`${marker} hub`);
    for (const kind of ['bot', 'skill', 'bot check', 'decide check', 'script check', 'workflow', 'job', 'note'])
      expect(text(config)).toContain(`${marker} ${kind}`);
  });

  it('never reaches a job prompt, a check prompt, a decide question, preload, recall or the hub tools', async () => {
    const { dir, config, issues } = await hub();
    const leaked: string[] = [];
    const look = (where: string, value: unknown) => {
      if (text(value).includes(marker)) leaked.push(where);
    };

    const workflow = config.workflows.w!;
    look(
      'job spec',
      buildSpec({ config, workflow, job: 'loop', event, cwd: '/w', hub: dir, data: temp('human-data') }).spec
    );

    const decided: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        decided.push(JSON.parse(String(init.body)));
        return Response.json({ answers: { answer: { type: 'noul', noul: 0.9 } } });
      })
    );
    const { seen, adapters } = recording();
    const dataDir = temp('human-pipeline');
    const origin = sourceRepo();
    const result = await Effect.runPromise(
      runPlanned(
        { workflow: 'w', job: 'loop', bot: 'worker' },
        {
          config,
          event,
          issues,
          hub: dir,
          data: dataDir,
          store: openStore(dataDir),
          workspaces: workspaces({ dataDir, cloneUrl: () => origin.dir }),
          limit: await Effect.runPromise(limiter(1)),
          env: { BOTHUB_LLM_API_KEY: 'key', BOTHUB_DECIDE_URL: 'http://decide.test' },
          adapters,
          launch: unsandboxed,
        }
      )
    );
    if (!('run' in result)) throw new Error('skipped');
    expect(result.outcome?.checks?.map(c => c.check)).toEqual(['judged', 'asked', 'ran']);
    expect(seen.some(s => s.system.startsWith('You judge.'))).toBe(true);
    expect(decided.length).toBeGreaterThan(0);
    seen.forEach((spec, i) => look(`run spec ${i}`, spec));
    decided.forEach((body, i) => look(`decide request ${i}`, body));
    look('outcome', result.outcome);

    const preloaded = await issueContext(issues, event, ['issue', 'links']);
    expect(preloaded).toContain('Do the small change.');
    look('preloaded issue', preloaded);

    const docs = [
      ...noteDocs(config.notes),
      ...issueDocs(await Promise.all([7, 8].map(async n => (await issues.get(n))!))),
    ];
    look('recall docs', docs);
    look('recall hits', index(docs).search('small change limits budgets related task'));

    const sources = { config, issues };
    for (const [name, args] of [
      ['issues_list', {}],
      ['issues_get', { number: 7 }],
      ['notes_search', { query: 'small' }],
      ['notes_get', { kind: 'style', slug: 'small' }],
      ['notes_get', { kind: 'caveat', slug: 'limits' }],
    ] as const) {
      const reply = await callTool(McpTool.options, name, args, sources);
      expect(reply.isError).toBeUndefined();
      look(`tool ${name}`, reply);
    }

    expect(leaked).toEqual([]);
  });

  it('survives a local issue being rewritten through bothub', async () => {
    const { issues } = await hub();
    await issues.label(7, { add: ['bug'] });
    expect((await issues.get(7))?.human).toEqual({ source: `${marker} issue`, other: `${marker} extra` });
    await issues.label(8, { add: ['bug'] });
    expect((await issues.get(8))?.human).toBe(`${marker} linked issue`);
  });

  it('takes plain text or a map of strings', () => {
    const compiled = compile([
      { path: 'skills/s.md', source: '---\ndescription: d\nhuman: { refs: [a] }\n---\n\nDo.\n' },
    ]);
    expect(compiled.ok).toBe(false);
  });
});
