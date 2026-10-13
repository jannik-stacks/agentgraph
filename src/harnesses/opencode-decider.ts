import { decide, defaultDecideModel, defaultDecideUrl, defaultThreshold } from '../decide.ts';
import type { agentTriggers } from '../schema.ts';
import { endpointOf, items, type Endpoint } from '../summaries.ts';
import { markLoaded } from './opencode-surfacer.ts';

/**
 * One yes-or-no question for the decision model at a hook point. Yes means all is well; below `threshold` the
 * decider acts with `say`: a `tool_call` is denied, a `tool_result` or `stop` gets a one-line nudge. `unreachable`
 * says what happens when the model cannot answer: `act` (the default for `tool_call`) or `skip` (for the others).
 */
export type DeciderQuestion = {
  on: Extract<(typeof agentTriggers)[number], 'tool_call' | 'tool_result' | 'stop'>;
  ask: string;
  say: string;
  tools?: string[];
  threshold?: number;
  unreachable?: 'act' | 'skip';
};

/** What the decider plugin gets from bothub, as opencode plugin options. `llm` serves a chat decision model. */
export type DeciderOptions = {
  questions: DeciderQuestion[];
  decide?: { url?: string; model?: string; timeoutMs?: number };
  llm?: Endpoint;
};

type Part = { type: string; text?: string; synthetic?: boolean };
type Session = { task: string; calls: string[] };

const maxState = 6000;

const clip = (text: string) =>
  text.length > maxState ? `${text.slice(0, maxState / 2)}\n[…]\n${text.slice(-maxState / 2)}` : text;

/** opencode server plugin: asks the decision model its questions at tool calls, tool results and final messages. */
export const decider = async (_input: unknown, raw?: Record<string, unknown>) => {
  const o = raw as DeciderOptions;
  await markLoaded(deciderId);
  const url = o.decide?.url ?? (process.env.BOTHUB_DECIDE_URL || defaultDecideUrl);
  const model = o.decide?.model ?? (process.env.BOTHUB_DECIDE_MODEL || defaultDecideModel);
  const timeoutMs = o.decide?.timeoutMs ?? 20_000;
  const llm = o.llm ?? endpointOf(process.env);

  const sessions = new Map<string, Session>();
  const session = (id: string) => {
    if (!sessions.has(id)) sessions.set(id, { task: '', calls: [] });
    return sessions.get(id)!;
  };

  const asked = (on: DeciderQuestion['on'], tool?: string) =>
    o.questions.filter(q => q.on === on && (!q.tools || (tool !== undefined && q.tools.includes(tool))));

  /** The questions whose answer, or missing answer, calls for action. */
  const judge = async (questions: DeciderQuestion[], state: string) => {
    if (!questions.length) return [];
    try {
      const answers = await decide({
        url,
        model,
        llm,
        timeoutMs,
        state: clip(state),
        questions: Object.fromEntries(
          questions.map((q, i) => [`q${i}`, { type: 'noul' as const, instructions: q.ask }])
        ),
      });
      return questions.filter((q, i) => answers[`q${i}`]!.noul < (q.threshold ?? defaultThreshold));
    } catch {
      return questions.filter(q => (q.unreachable ?? (q.on === 'tool_call' ? 'act' : 'skip')) === 'act');
    }
  };

  const nudge = (acted: DeciderQuestion[]) => acted.map(q => `\n\n[bothub] ${q.say}`).join('');

  return {
    'chat.message': async ({ sessionID }: { sessionID: string }, { parts }: { parts: Part[] }) => {
      const s = session(sessionID);
      if (!s.task)
        s.task = parts
          .filter(p => p.type === 'text' && !p.synthetic)
          .map(p => p.text ?? '')
          .join('\n');
    },
    'tool.execute.before': async (
      { tool, sessionID }: { tool: string; sessionID: string },
      { args }: { args: unknown }
    ) => {
      const s = session(sessionID);
      const acted = await judge(
        asked('tool_call', tool),
        `Task:\n${s.task}\n\nThe agent wants to call ${tool} with:\n${JSON.stringify(args, null, 2)}`
      );
      if (acted.length) throw new Error(`bothub denied this call: ${acted.map(q => q.say).join(' ')}`);
    },
    'tool.execute.after': async (
      { tool, sessionID, callID, args }: { tool: string; sessionID: string; callID: string; args: unknown },
      result: { output: string }
    ) => {
      const s = session(sessionID);
      const [item] = items([
        { ts: '', seq: 0, event: { type: 'tool_call', id: callID, tool, input: args } },
        { ts: '', seq: 1, event: { type: 'tool_result', id: callID, ok: true, output: result.output } },
      ]);
      if (item) s.calls.push(item.line);
      const acted = await judge(
        asked('tool_result', tool),
        `Task:\n${s.task}\n\nThe agent called ${tool} with:\n${JSON.stringify(args, null, 2)}\n\nResult:\n${result.output}`
      );
      result.output += nudge(acted);
    },
    'experimental.text.complete': async ({ sessionID }: { sessionID: string }, output: { text: string }) => {
      if (!output.text.trim()) return;
      const s = session(sessionID);
      const acted = await judge(
        asked('stop'),
        `Task:\n${s.task}\n\nTool calls so far:\n${s.calls.join('\n') || 'none'}\n\nThe agent's message:\n${output.text}`
      );
      output.text += nudge(acted);
    },
  };
};

const deciderId = 'bothub-decider';

export default { id: deciderId, server: decider };
