import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { makeCodexHarness } from '../harnesses/codex.ts';
import type { SessionSpec } from '../src/trace.ts';
import {
  defaultPass,
  defaultReturns,
  findMismatch,
  getRecordedResult,
  makeResultServer,
  readScriptResult,
  whyPassUndecided,
  type ResultType,
} from '../src/result.ts';
import { harnesses } from './fixtures.ts';

const talk = (returns: ResultType, ...messages: (object | string)[]) =>
  spawnSync(process.execPath, makeResultServer(returns).args, {
    input: messages.map(m => (typeof m === 'string' ? m : JSON.stringify({ jsonrpc: '2.0', ...m }))).join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
    .stdout.trim()
    .split('\n')
    .map(line => JSON.parse(line));

const call = (id: number, args: unknown, name = 'result') => ({
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

const stuck: ResultType = {
  type: 'object',
  required: ['wasted', 'stuck'],
  properties: {
    wasted: { type: 'integer', minimum: 0 },
    stuck: { enum: ['nothing', 'tests'] },
    files: { type: 'array', items: { type: 'string' } },
  },
};

describe('the result server', () => {
  it('answers the handshake, lists the result tool typed by returns and turns away a call returns refuses', () => {
    const answers = talk(
      defaultReturns,
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      call(3, { pass: 'yes', why: 'fine' }),
      call(4, { why: 'fine' }),
      call(5, { pass: true, why: 'fine' }),
      { id: 6, method: 'resources/list' },
      call(7, null),
      'not json',
      call(8, { pass: true }, 'verdict')
    );
    expect(answers.map(a => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7, null, 8]);
    expect(answers[0].result.protocolVersion).toBe('2025-06-18');
    expect(answers[1].result.tools).toEqual([expect.objectContaining({ name: 'result', inputSchema: defaultReturns })]);
    expect(answers.slice(2, 5).map(a => [a.result.isError, a.result.content[0].text.split(' (')[0]])).toEqual([
      [true, 'result.pass must be a boolean'],
      [true, 'result.pass is missing'],
      [false, 'Recorded.'],
    ]);
    expect([answers[5].error.code, answers[6].result.isError, answers[7].error.code, answers[8].error.code]).toEqual([
      -32601,
      true,
      -32700,
      -32601,
    ]);
  });

  it('says what the engine says about every mismatch', () => {
    const values = [
      { wasted: 1, stuck: 'tests' },
      { wasted: 1.5, stuck: 'tests' },
      { wasted: -1, stuck: 'tests' },
      { wasted: 1, stuck: 'types' },
      { wasted: 1, stuck: 'nothing', files: ['a', 2] },
      { stuck: 'nothing' },
      [1],
    ];
    const said = talk(stuck, ...values.map((v, i) => call(i, v))).map(a => a.result.content[0].text);
    expect(said).toEqual(values.map(v => findMismatch(stuck, v)?.concat('. Call result again.') ?? 'Recorded.'));
    expect(said.slice(1)).toEqual([
      'result.wasted must be an integer. Call result again.',
      'result.wasted must be at least 0. Call result again.',
      'result.stuck must be one of ["nothing","tests"]. Call result again.',
      'result.files[1] must be a string. Call result again.',
      'result.wasted is missing. Call result again.',
      'result must be a object. Call result again.',
    ]);
  });
});

describe('a pass', () => {
  it('decides by the result own pass unless the check says otherwise', () =>
    expect([
      findMismatch(defaultPass, { pass: true }),
      findMismatch(defaultPass, { pass: false, why: 'off' }),
      findMismatch(defaultPass, { n: 3 }),
    ]).toEqual([undefined, 'result.pass must be true', 'result.pass is missing']));

  it('is refused when it could never decide on the results returns describes', () =>
    expect([
      whyPassUndecided(defaultReturns, defaultPass),
      whyPassUndecided(stuck, { properties: { wasted: { maximum: 2 } } }),
      whyPassUndecided(stuck, defaultPass),
      whyPassUndecided(stuck, { properties: { stuck: { maximum: 2 } } }),
      whyPassUndecided(stuck, { properties: { files: { const: [] } } }),
    ]).toEqual([
      undefined,
      undefined,
      'result.pass is not a required field of returns',
      'result.stuck is not a number in returns, so it has no minimum or maximum',
      'result.files is not a required field of returns',
    ]));
});

describe('a script result', () => {
  it('is the JSON object on its last line, and nothing when that line is no JSON object', () =>
    expect(['counting\n{"n": 3}\n', '0.7\n', '{n: 3\n', '[1]\n'].map(readScriptResult)).toEqual([
      { n: 3 },
      undefined,
      undefined,
      undefined,
    ]));
});

const route = { url: 'http://litellm:4000/v1', model: 'smart' };
const judge: SessionSpec = {
  harness: 'opencode',
  agent: 'checker',
  system: 'You judge.',
  prompt: 'Is it right?',
  dir: '/work',
  tools: ['read'],
  minutes: 5,
  check: 'claims',
  returns: defaultReturns,
};
const { returns: _plain, ...plain } = judge;
const wiring = (name: string, spec: Omit<SessionSpec, 'model'>) => {
  const harness = harnesses.find(h => h.name === name)!;
  return JSON.stringify([harness.command(spec, route), harness.home?.(spec, route)]);
};
const description = makeResultServer(defaultReturns).args.at(-1)!;

describe('a judge session', () => {
  it.each(['claude', 'codex', 'opencode', 'pi'])('on %s gets the result tool, and only a judge does', name =>
    expect([wiring(name, judge), wiring(name, plain)].map(text => text.includes(description))).toEqual([true, false])
  );

  it.each([
    ['claude', 'mcp__agentgraph__result'],
    ['codex', 'mcp_servers.agentgraph.default_tools_approval_mode=\\"approve\\"'],
    ['opencode', '\\"agentgraph_result\\":\\"allow\\"'],
    ['pi', 'mcp__agentgraph__result'],
  ])('on %s is allowed to call it', (name, allowed) => expect(wiring(name, judge)).toContain(allowed));

  it('drops claude safe mode only for a judge, since safe mode drops every MCP server', () => {
    const args = (spec: Omit<SessionSpec, 'model'>) =>
      harnesses.find(h => h.name === 'claude')!.command(spec, route).args;
    expect([args(judge).includes('--safe-mode'), args(plain).includes('--safe-mode')]).toEqual([false, true]);
  });

  it('turns on pi MCP and declares the tool directly', () => {
    const pi = harnesses.find(h => h.name === 'pi')!;
    const servers = JSON.parse(pi.home!(judge, route).files!['.pi/agent/mcp.json']!).mcpServers;
    expect(servers.agentgraph).toMatchObject({
      command: 'node',
      args: makeResultServer(defaultReturns).args,
      exposure: 'direct',
    });
    expect(pi.command(judge, route).args.join(' ')).toContain('-e builtin:mcp');
  });

  it('reads codex MCP calls as tool calls, failed ones as not ok', () => {
    const parse = makeCodexHarness().parse();
    const item = (status: string) => ({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'mcp_tool_call',
        server: 'agentgraph',
        tool: 'result',
        arguments: { pass: true, why: 'fine' },
        result: { content: [{ type: 'text', text: 'Recorded.' }] },
        status,
      },
    });
    const tool = { type: 'tool', id: 'item_1', name: 'mcp__agentgraph__result', input: { pass: true, why: 'fine' } };
    expect([...parse(item('completed')), ...parse(item('failed'))]).toEqual([
      { ...tool, ok: true, output: 'Recorded.' },
      { ...tool, ok: false, output: 'Recorded.' },
    ]);
  });
});

const event = (name: string, input: unknown, ok = true) => ({ name, input, ok });

describe('a recorded result', () => {
  it('is read from a successful call under either tool name when it matches returns', () =>
    expect([
      getRecordedResult(defaultReturns, event('mcp__agentgraph__result', { pass: false, why: 'x' })),
      getRecordedResult(stuck, event('agentgraph_result', { wasted: 3, stuck: 'tests' })),
      getRecordedResult(stuck, event('mcp__agentgraph__result', { wasted: true, stuck: 'tests' })),
      getRecordedResult(defaultReturns, event('mcp__agentgraph__result', { pass: true }, false)),
      getRecordedResult(defaultReturns, event('mcp__other__result', { pass: true })),
    ]).toEqual([{ pass: false, why: 'x' }, { wasted: 3, stuck: 'tests' }, undefined, undefined, undefined]));
});
