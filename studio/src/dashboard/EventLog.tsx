import type { EventRecord } from '../../../src/store.ts';
import type { AgentEvent } from '../../../src/types.ts';
import { Badge, cx, Field, Fields, Pre } from '../ui.tsx';

type Result = Extract<AgentEvent, { type: 'tool_result' }>;
type Item = { seq: number; event: AgentEvent; result?: Result };

const pair = (records: EventRecord[]) => {
  const items: Item[] = [];
  const calls = new Map<string, Item>();
  for (const { seq, event } of records) {
    const call = event.type === 'tool_result' ? calls.get(event.id) : undefined;
    if (call && event.type === 'tool_result') {
      call.result = event;
      continue;
    }
    const item: Item = { seq, event };
    if (event.type === 'tool_call') calls.set(event.id, item);
    items.push(item);
  }
  return items;
};

const format = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

const ToolCall = ({ event, result }: { event: Extract<AgentEvent, { type: 'tool_call' }>; result?: Result }) => (
  <details className="rounded border border-zinc-200 dark:border-zinc-800">
    <summary className="flex cursor-pointer items-center gap-2 px-2 py-1">
      <span className="font-mono font-medium">{event.tool}</span>
      {result ? <Badge tone={result.ok ? 'ok' : 'danger'}>{result.ok ? 'ok' : 'error'}</Badge> : <Badge>pending</Badge>}
    </summary>
    <div className="space-y-2 border-t border-zinc-200 p-2 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">input</div>
      <Pre>{format(event.input)}</Pre>
      {result?.output !== undefined && (
        <>
          <div className="text-xs text-zinc-500">output</div>
          <Pre>{result.output}</Pre>
        </>
      )}
    </div>
  </details>
);

const End = ({ event }: { event: Extract<AgentEvent, { type: 'end' }> }) => (
  <div
    className={cx(
      'space-y-2 rounded border p-3',
      event.ok ? 'border-emerald-300 dark:border-emerald-900' : 'border-red-300 dark:border-red-900'
    )}
  >
    <Fields>
      <Field name="result">
        <Badge tone={event.ok ? 'ok' : 'danger'}>{event.ok ? 'ok' : 'failed'}</Badge>
      </Field>
      {event.turns !== undefined && <Field name="turns">{event.turns}</Field>}
      {event.costUsd !== undefined && <Field name="cost">${event.costUsd.toFixed(4)}</Field>}
    </Fields>
    {event.result && <Pre>{event.result}</Pre>}
  </div>
);

const Entry = ({ item: { event, result } }: { item: Item }) => {
  switch (event.type) {
    case 'start':
      return (
        <div className="text-xs text-zinc-500">
          session started{event.model && ` with ${event.model}`}
          {event.session && <span className="font-mono"> {event.session}</span>}
        </div>
      );
    case 'text':
      return <p className="whitespace-pre-wrap">{event.text}</p>;
    case 'tool_call':
      return <ToolCall event={event} {...(result && { result })} />;
    case 'tool_result':
      return (
        <div className="text-xs text-zinc-500">
          result for {event.id}: {event.ok ? 'ok' : 'error'}
          {event.output && <Pre>{event.output}</Pre>}
        </div>
      );
    case 'usage':
      return (
        <div className="text-xs text-zinc-500">
          {event.inputTokens} tokens in, {event.outputTokens} out
        </div>
      );
    case 'end':
      return <End event={event} />;
    case 'error':
      return <div className="text-red-600 dark:text-red-400">{event.message}</div>;
  }
};

export const EventLog = ({ records }: { records: EventRecord[] }) => (
  <ol className="space-y-2">
    {pair(records).map(item => (
      <li key={item.seq}>
        <Entry item={item} />
      </li>
    ))}
  </ol>
);
