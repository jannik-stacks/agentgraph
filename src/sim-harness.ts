/**
 * A scripted stand-in for a harness, used by `bothub sim`. It reads its steps from the file in `BOTHUB_SIM_STEPS`,
 * calls hub tools through the MCP server in `BOTHUB_SIM_MCP`, writes files into its working directory, and prints
 * one `AgentEvent` per line.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { McpServer } from './mcp-config.ts';
import type { SimStep } from './sim.ts';
import type { AgentEvent } from './types.ts';

const emit = (event: AgentEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);

/** A minimal MCP client over the server's stdio: one request at a time, answered by id. */
const connect = (server: McpServer) => {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
    waiting.get(message.id)?.(message);
  });
  let next = 0;
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: { message: string } }>(resolve => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bothub-sim', version: '0' },
  }).then(() => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`));
  return {
    call: async (name: string, args: unknown) => {
      await ready;
      const { result, error } = await request('tools/call', { name, arguments: args });
      if (error) return { ok: false, text: error.message };
      const { content = [], isError } = result as { content?: { text?: string }[]; isError?: boolean };
      return { ok: !isError, text: content.map(c => c.text ?? '').join('\n') };
    },
    close: () => child.stdin.end(),
  };
};

const run = async () => {
  const file = process.env.BOTHUB_SIM_STEPS;
  const steps = file ? (JSON.parse(await readFile(file, 'utf8')) as SimStep[]) : [];
  const server = process.env.BOTHUB_SIM_MCP ? (JSON.parse(process.env.BOTHUB_SIM_MCP) as McpServer) : undefined;
  const mcp = server && connect(server);
  emit({ type: 'start', model: 'sim' });
  let final = '';
  let turns = 0;
  for (const step of steps) {
    turns++;
    if ('say' in step) emit({ type: 'text', text: (final = step.say) });
    else if ('call' in step) {
      const id = `call-${turns}`;
      emit({ type: 'tool_call', id, tool: step.call, input: step.with ?? {} });
      const result = mcp
        ? await mcp.call(step.call, step.with ?? {})
        : { ok: false, text: 'no hub tools are mounted for this run' };
      emit({ type: 'tool_result', id, ok: result.ok, output: result.text });
    } else if ('write' in step) {
      for (const [path, content] of Object.entries(step.write)) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
    } else if ('propose' in step) {
      final = ['Done.', '```bothub', JSON.stringify(step.propose, null, 2), '```'].join('\n');
      emit({ type: 'text', text: final });
    } else {
      mcp?.close();
      const message = 'fail' in step ? step.fail : step.limit;
      if ('limit' in step) emit({ type: 'error', message });
      emit({ type: 'end', ok: false, turns, result: message });
      return;
    }
  }
  mcp?.close();
  emit({ type: 'end', ok: true, turns, result: final });
};

await run();
