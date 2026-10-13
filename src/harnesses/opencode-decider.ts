import { decide, defaultDecideModel, defaultDecideUrl } from '../decide.ts';
import type { DeciderQuestion } from '../schema.ts';
import { endpointOf, items, type Endpoint } from '../summaries.ts';
import { markLoaded, report } from './opencode-surfacer.ts';

/**
 * What the decider plugin gets from bothub, as opencode plugin options: the questions, the `task` they are asked
 * against, and where the decision model is. `llm` serves a chat decision model.
 */
export type DeciderOptions = {
  questions: DeciderQuestion[];
  task: string;
  decide?: { url?: string; model?: string; timeoutMs?: number };
  llm?: Endpoint;
};

/**
 * opencode server plugin: asks the decision model its questions at tool calls, tool results and final messages,
 * reports each answer as a `decision` event and each model call as a `usage` event, and acts only on questions in
 * `act` mode. A model that cannot answer never acts.
 */
export const decider = async (_input: unknown, raw?: Record<string, unknown>) => {
  const o = raw as DeciderOptions;
  await markLoaded(deciderId);
  const url = o.decide?.url ?? (process.env.BOTHUB_DECIDE_URL || defaultDecideUrl);
  const model = o.decide?.model ?? (process.env.BOTHUB_DECIDE_MODEL || defaultDecideModel);
  const timeoutMs = o.decide?.timeoutMs ?? 5_000;
  const llm = o.llm ?? endpointOf(process.env);
  const calls: string[] = [];

  /** The questions asked at `on` for `tool` whose answer calls for action. */
  const judge = async (on: DeciderQuestion['on'], state: string, tool?: string, call?: string) => {
    const questions = o.questions.filter(
      q => q.on === on && (!q.tools || (tool !== undefined && q.tools.includes(tool)))
    );
    if (!questions.length) return [];
    let answers: Record<string, { noul: number } | undefined> = {};
    let error: string | undefined;
    try {
      answers = await decide({
        url,
        model,
        llm,
        timeoutMs,
        onUsage: usage => report({ ...usage, source: 'decider' }),
        state: `${state}\n\nTask:\n${o.task}`,
        questions: Object.fromEntries(
          questions.map((q, i) => [`q${i}`, { type: 'noul' as const, instructions: q.ask }])
        ),
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return questions.filter((q, i) => {
      const p = answers[`q${i}`]?.noul;
      const acted = q.mode === 'act' && p !== undefined && p < q.threshold!;
      report({
        type: 'decision',
        on,
        ask: q.ask,
        ...(tool && { tool }),
        ...(call && { call }),
        ...(p !== undefined && { p }),
        ...(q.threshold !== undefined && { threshold: q.threshold }),
        acted,
        ...(error && { error }),
      });
      return acted;
    });
  };

  const nudge = (acted: DeciderQuestion[]) => acted.map(q => `\n\n[bothub] ${q.say}`).join('');

  return {
    'tool.execute.before': async ({ tool, callID }: { tool: string; callID: string }, { args }: { args: unknown }) => {
      const acted = await judge(
        'tool_call',
        `The agent wants to call ${tool} with:\n${JSON.stringify(args)}`,
        tool,
        callID
      );
      if (acted.length) throw new Error(`bothub denied this call: ${acted.map(q => q.say).join(' ')}`);
    },
    'tool.execute.after': async (
      { tool, callID, args }: { tool: string; callID: string; args: unknown },
      result: { output: string }
    ) => {
      const [item] = items([
        { ts: '', seq: 0, event: { type: 'tool_call', id: callID, tool, input: args } },
        { ts: '', seq: 1, event: { type: 'tool_result', id: callID, ok: true, output: result.output } },
      ]);
      if (item) calls.push(item.line);
      const acted = await judge(
        'tool_result',
        `The agent called ${tool} with:\n${JSON.stringify(args)}\n\nResult:\n${result.output}`,
        tool,
        callID
      );
      result.output += nudge(acted);
    },
    'experimental.text.complete': async (_: unknown, output: { text: string }) => {
      if (!output.text.trim()) return;
      const acted = await judge(
        'stop',
        `The agent's message:\n${output.text}\n\nTool calls so far:\n${calls.join('\n') || 'none'}`
      );
      output.text += nudge(acted);
    },
  };
};

const deciderId = 'bothub-decider';

export default { id: deciderId, server: decider };
