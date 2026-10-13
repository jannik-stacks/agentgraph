import { useAtomValue, useSetAtom } from 'jotai';
import {
  createContext,
  memo,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { RunRow } from '../../../src/live.ts';
import type { EventRecord } from '../../../src/store.ts';
import { estimate, type Price, sum, tokensOf } from '../../../src/usage.ts';
import { infoAtom } from '../info.ts';
import { navigateAtom } from '../state.ts';
import { Icon, KindIcon } from '../studio/icons.tsx';
import { Button, cx, Tooltip } from '../ui.tsx';
import { age, Cost, Elapsed, formatTokens, Io, StatusIcon, useEnter } from './bits.tsx';
import { fetchEvents, fetchOutcome, followedAtom, pricesAtom, recordKey, runRowsAtom } from './live.ts';
import {
  attemptsOf,
  checksOf,
  costOf,
  eventTitle,
  isFailed,
  isLive,
  type Prices,
  rootOf,
  type ToolStep,
  tokensByKind,
  toolCost,
  topTools,
  type Turn,
  turnsOf,
} from './model.ts';
import { OutcomeView, RunFields, Text, ToolBody, toolSummary, VerdictView } from './render/index.tsx';

type Mode = 'auto' | 'all' | 'none';
const Steps = createContext<{
  mode: Mode;
  overrides: Record<string, boolean>;
  toggle: (id: string, open: boolean) => void;
}>({ mode: 'auto', overrides: {}, toggle: () => {} });

/**
 * A collapsible step. Its body renders only while open; `auto` says whether it starts open. `head` may depend on
 * whether the step is open, so a running step can hand its spinner down to the step inside it. `fresh` is the key
 * whose first arrival animates the step in. With `stay`, a step that opened on its own stays open after `auto` turns
 * false, so a run that finishes does not fold away under the reader.
 */
const Step = ({
  id,
  auto,
  head,
  children,
  depth = 0,
  fresh = '',
  stay = false,
}: {
  id: string;
  auto: boolean;
  head: ReactNode | ((open: boolean) => ReactNode);
  children: () => ReactNode;
  depth?: number;
  fresh?: string;
  stay?: boolean;
}) => {
  const { mode, overrides, toggle } = useContext(Steps);
  const enter = useEnter(fresh);
  const [opened, setOpened] = useState(auto);
  if (stay && auto && !opened) setOpened(true);
  const open = overrides[id] ?? (mode === 'all' ? true : mode === 'none' ? false : stay ? opened : auto);
  return (
    <li className={cx('[contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]', enter)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggle(id, !open)}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
        style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
      >
        <Icon name="chevron" className={cx('size-3 text-zinc-400 transition-transform', open && 'rotate-90')} />
        {typeof head === 'function' ? head(open) : head}
      </button>
      {open && <div style={{ paddingLeft: `${1.5 + depth * 1}rem` }}>{children()}</div>}
    </li>
  );
};

const Row = ({ children }: { children: ReactNode }) => (
  <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
);

const Right = ({ children }: { children: ReactNode }) => (
  <span className="ml-auto flex shrink-0 items-center gap-3">{children}</span>
);

const ToolLine = memo(function ToolLine({
  runId,
  tool,
  price,
  depth,
}: {
  runId: string;
  tool: ToolStep;
  price: Price | undefined;
  depth: number;
}) {
  const cost = toolCost(tool, price);
  const failed = tool.result?.ok === false;
  return (
    <Step
      id={tool.call.id}
      auto={failed}
      depth={depth}
      fresh={recordKey(runId, tool.seq)}
      head={
        <Row>
          <Tooltip tip="Tool call">
            <KindIcon kind="tool" className="size-3" title="" />
          </Tooltip>
          <span className="font-mono">{tool.call.tool.replace(/^bothub_/, '')}</span>
          <span className="min-w-0 truncate font-mono text-zinc-500">
            {toolSummary(tool.call.tool, tool.call.input)}
          </span>
          {!tool.result && <StatusIcon status="running" className="size-3" tip="Tool running" />}
          {failed && <StatusIcon status="failed" className="size-3" tip="Tool failed" />}
          <Right>
            <Tooltip
              tip={`Result: ${tool.resultChars.toLocaleString()} characters, about ${formatTokens(cost.result)} tokens\nRead again by ${tool.carried} later ${tool.carried === 1 ? 'call' : 'calls'}: ${formatTokens(cost.carried)} tokens in all`}
            >
              <span className="inline-flex items-center text-fd-muted-foreground tabular-nums">
                {formatTokens(cost.carried || cost.result)}
                <Icon name="in" className="size-3" />
                {tool.carried > 1 && <span className="ml-0.5">x{tool.carried}</span>}
              </span>
            </Tooltip>
            <Tooltip
              tip={`Arguments: ${tool.argChars.toLocaleString()} characters, about ${formatTokens(cost.args)} tokens`}
            >
              <span className="inline-flex items-center text-fd-muted-foreground tabular-nums">
                {formatTokens(cost.args)}
                <Icon name="out" className="size-3" />
              </span>
            </Tooltip>
            {cost.estimated !== undefined && (
              <Cost
                billed={0}
                estimated={cost.estimated}
                tip="What this result costs as input to the calls that read it"
                className="w-14 justify-end"
              />
            )}
          </Right>
        </Row>
      }
    >
      {() => (
        <div className="py-1 pr-2">
          <ToolBody
            tool={tool.call.tool}
            input={tool.call.input}
            {...(tool.result?.output !== undefined && { output: tool.result.output })}
            {...(tool.result && { ok: tool.result.ok })}
          />
        </div>
      )}
    </Step>
  );
});

const turnSummary = (turn: Turn) =>
  turn.texts[0]?.text.split('\n')[0]?.slice(0, 120) ??
  turn.tools.map(t => t.call.tool.replace(/^bothub_/, '')).join(', ');

const TurnLine = memo(function TurnLine({
  runId,
  turn,
  price,
  live,
  depth,
}: {
  runId: string;
  turn: Turn;
  price: Price | undefined;
  live: boolean;
  depth: number;
}) {
  const u = turn.usage;
  const tally = u && {
    in: u.inputTokens,
    out: u.outputTokens,
    cached: u.cachedInputTokens ?? 0,
    reasoning: u.reasoningTokens ?? 0,
  };
  return (
    <Step
      id={`${runId}:${turn.index}`}
      auto={live || turn.tools.some(t => t.result?.ok === false)}
      depth={depth}
      fresh={recordKey(runId, turn.seq)}
      head={open => (
        <Row>
          <Tooltip tip="Model call">
            <Icon name="model" className="size-3 text-zinc-400" />
          </Tooltip>
          <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">{turnSummary(turn)}</span>
          {live && !(open && turn.tools.some(t => !t.result)) && (
            <StatusIcon status="running" className="size-3" tip="The model is working" />
          )}
          <Right>
            {turn.grew !== undefined && (
              <Tooltip tip="Input added since the previous call: new messages and tool results">
                <span className="text-zinc-400 tabular-nums">+{formatTokens(turn.grew)}</span>
              </Tooltip>
            )}
            {tally && <Io tally={tally} />}
            {tally && (
              <Cost
                billed={u.costUsd ?? 0}
                estimated={estimate(tally, price)}
                tally={tally}
                className="w-14 justify-end"
              />
            )}
          </Right>
        </Row>
      )}
    >
      {() => (
        <ul className="space-y-1 py-1">
          {turn.texts.map(t => (
            <li key={t.seq} className="pr-2">
              <Text text={t.text} />
            </li>
          ))}
          {turn.tools.map(tool => (
            <ToolLine key={tool.call.id} runId={runId} tool={tool} price={price} depth={0} />
          ))}
        </ul>
      )}
    </Step>
  );
});

/** A run's model calls and tool calls as steps; the last one stays open while the run is live. */
const Transcript = ({ run, records, price }: { run: RunRow; records: EventRecord[]; price: Price | undefined }) => {
  const { turns, start, end, errors } = useMemo(() => turnsOf(records), [records]);
  const live = isLive(run.status);
  const first = turns.find(t => t.usage)?.usage;
  return (
    <ul className="py-0.5">
      <li className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
        <Tooltip tip="Model">
          <Icon name="model" className="size-3" />
        </Tooltip>
        <span>{start?.model ?? run.model ?? run.harness}</span>
        {first && (
          <Tooltip tip="Setup: the first call's input, system prompt, preloaded notes, task and tool definitions">
            <span className="inline-flex items-center text-fd-muted-foreground tabular-nums">
              {formatTokens(first.inputTokens)}
              <Icon name="in" className="size-3" />
              <span className="ml-1">setup</span>
            </span>
          </Tooltip>
        )}
      </li>
      {turns.map((turn, i) => (
        <TurnLine
          key={turn.index}
          runId={run.id}
          turn={turn}
          price={price}
          live={live && i === turns.length - 1}
          depth={0}
        />
      ))}
      {errors.map((message, i) => (
        <li key={i} className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
          {message}
        </li>
      ))}
      {end && (
        <li className="flex items-center gap-2 px-2 py-1 text-xs">
          <StatusIcon
            status={end.ok ? 'succeeded' : 'failed'}
            tip={end.ok ? 'The harness finished' : 'The harness failed'}
          />
          {end.turns !== undefined && <span className="text-zinc-500">{end.turns} turns</span>}
        </li>
      )}
      {!records.length && (
        <li className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
          {live && <StatusIcon status={run.status} className="size-3" />}
          {live ? 'Waiting for the first event.' : 'No events.'}
        </li>
      )}
    </ul>
  );
};

const FetchedTranscript = ({ run, price }: { run: RunRow; price: Price | undefined }) => (
  <Transcript run={run} records={use(fetchEvents(run.id, run.status))} price={price} />
);

/** The records of `run`: streamed when it is the followed run, fetched once otherwise. */
const RunTranscript = ({ run, prices }: { run: RunRow; prices: Prices }) => {
  const followed = useAtomValue(followedAtom);
  const price = run.model ? prices[run.model] : undefined;
  if (followed?.id === run.id) return <Transcript run={run} records={followed.records} price={price} />;
  return (
    <Suspense fallback={<p className="px-2 py-1 text-xs text-zinc-500">Loading.</p>}>
      <FetchedTranscript run={run} price={price} />
    </Suspense>
  );
};

/** A run's step head. Open, it leaves the spinner to the call inside that is running. */
const RunHead = ({ run, label, prices, open }: { run: RunRow; label: ReactNode; prices: Prices; open: boolean }) => {
  const cost = costOf(run.tally, run.model, prices);
  return (
    <Row>
      <StatusIcon status={run.status} level={open && run.status === 'running' ? 'job' : 'run'} />
      <span className="font-medium">{label}</span>
      <span className="truncate text-zinc-500">{[run.bot, run.model].filter(Boolean).join(', ')}</span>
      <Right>
        <Elapsed startedAt={run.startedAt} endedAt={run.endedAt ?? (isLive(run.status) ? undefined : run.startedAt)} />
        <Io tally={run.tally} />
        <Cost billed={cost.billed} estimated={cost.estimated} tally={run.tally} className="w-14 justify-end" />
      </Right>
    </Row>
  );
};

const useOutcome = (run: RunRow) => {
  const followed = useAtomValue(followedAtom);
  return followed?.id === run.id ? followed.outcome : undefined;
};

const FetchedVerdict = ({ attempt, name }: { attempt: RunRow; name: string }) => {
  const outcome = use(fetchOutcome(attempt.id, attempt.status));
  const verdict = outcome?.checks?.find(v => v.check === name);
  return verdict ? <VerdictView verdict={verdict} /> : null;
};

const CheckStep = ({
  attempt,
  name,
  runs,
  prices,
}: {
  attempt: RunRow;
  name: string;
  runs: RunRow[];
  prices: Prices;
}) => {
  const brief = attempt.brief?.checks?.find(v => v.check === name);
  const last = runs.at(-1);
  const failed = brief ? !brief.pass && !brief.skipped : last ? isFailed(last.status) : false;
  return (
    <Step
      id={`${attempt.id}:check:${name}`}
      auto={failed || (last !== undefined && isLive(last.status))}
      {...(runs[0] && { fresh: `run:${runs[0].id}` })}
      head={
        <Row>
          {brief ? (
            <Tooltip
              tip={
                brief.skipped
                  ? 'Check skipped'
                  : brief.pass
                    ? 'Check passed'
                    : brief.gating
                      ? 'Check failed and blocked the attempt'
                      : 'Check failed; shadow checks only report'
              }
            >
              <Icon
                name={brief.skipped ? 'skipped' : brief.pass ? 'ok' : 'fail'}
                className={cx(
                  'size-3.5',
                  brief.skipped
                    ? 'text-zinc-400'
                    : brief.pass
                      ? 'text-emerald-500'
                      : brief.gating
                        ? 'text-red-500'
                        : 'text-amber-500'
                )}
              />
            </Tooltip>
          ) : (
            last && <StatusIcon status={last.status} level="job" />
          )}
          <Tooltip tip="Check">
            <KindIcon kind="check" className="size-3" title="" />
          </Tooltip>
          <span className="font-medium">{name}</span>
          {brief && !brief.gating && <span className="text-zinc-500">shadow</span>}
          {runs.length > 1 && <span className="text-zinc-500">{runs.length} runs</span>}
          <Right>{runs.length > 0 && <Io tally={sum(runs.map(r => r.tally))} />}</Right>
        </Row>
      }
    >
      {() => (
        <div className="space-y-1 py-1 pr-2">
          {brief && (
            <Suspense fallback={null}>
              <FetchedVerdict attempt={attempt} name={name} />
            </Suspense>
          )}
          <ul>
            {runs.map(run => (
              <Step
                key={run.id}
                id={run.id}
                fresh={`run:${run.id}`}
                stay
                auto={isLive(run.status) || isFailed(run.status)}
                head={open => (
                  <RunHead run={run} label={age(run.startedAt ?? run.event.ts)} prices={prices} open={open} />
                )}
              >
                {() => <RunTranscript run={run} prices={prices} />}
              </Step>
            ))}
          </ul>
        </div>
      )}
    </Step>
  );
};

const AttemptStep = ({
  attempt,
  total,
  runs,
  prices,
}: {
  attempt: RunRow;
  total: number;
  runs: RunRow[];
  prices: Prices;
}) => {
  const checks = checksOf(attempt, runs);
  for (const verdict of attempt.brief?.checks ?? []) if (!checks.has(verdict.check)) checks.set(verdict.check, []);
  const label = total > 1 ? `attempt ${attempt.attempt ?? 1}/${total}` : attempt.job;
  return (
    <>
      <Step
        id={attempt.id}
        fresh={`run:${attempt.id}`}
        stay
        auto={isLive(attempt.status) || isFailed(attempt.status)}
        head={open => <RunHead run={attempt} label={label} prices={prices} open={open} />}
      >
        {() => <RunTranscript run={attempt} prices={prices} />}
      </Step>
      {[...checks].map(([name, list]) => (
        <CheckStep key={name} attempt={attempt} name={name} runs={list} prices={prices} />
      ))}
    </>
  );
};

const FetchedOutcome = ({ run }: { run: RunRow }) => {
  const outcome = use(fetchOutcome(run.id, run.status));
  return outcome ? <OutcomeView outcome={outcome} /> : <p className="text-xs text-zinc-500">No outcome.</p>;
};

const OutcomeStep = ({ run }: { run: RunRow }) => {
  const streamed = useOutcome(run);
  if (!run.brief && !streamed) return null;
  return (
    <Step
      id={`${run.id}:outcome`}
      auto={!isLive(run.status)}
      head={
        <Row>
          <Tooltip tip={run.brief?.applied ? 'What the run proposed was applied' : 'Nothing was applied'}>
            <Icon name={run.brief?.applied ? 'ok' : 'skipped'} className="size-3.5 text-zinc-500" />
          </Tooltip>
          <span className="font-medium">outcome</span>
          <span className="truncate text-zinc-500">{run.brief?.kinds.join(', ')}</span>
        </Row>
      }
    >
      {() => (
        <div className="py-1 pr-2">
          {streamed ? (
            <OutcomeView outcome={streamed} />
          ) : (
            <Suspense fallback={null}>
              <FetchedOutcome run={run} />
            </Suspense>
          )}
        </div>
      )}
    </Step>
  );
};

const kindLabels = {
  setup: 'setup, re-read every call',
  tools: 'tool results carried',
  conversation: 'conversation',
  output: 'output',
};
const kindColors = {
  setup: 'bg-violet-400',
  tools: 'bg-cyan-500',
  conversation: 'bg-zinc-400',
  output: 'bg-amber-500',
};

/** What made the followed run expensive: tokens by kind, its heaviest tool results, and cost per attempt and check. */
const Breakdown = ({ runs, records, prices }: { runs: RunRow[]; records: EventRecord[]; prices: Prices }) => {
  const { turns } = useMemo(() => turnsOf(records), [records]);
  const kinds = tokensByKind(turns);
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  const heavy = topTools(turns).filter(t => t.carried && t.resultChars);
  return (
    <div className="space-y-2 px-2 py-1 text-xs">
      {total > 0 && (
        <div className="space-y-1">
          <Tooltip
            className="w-full"
            tip={Object.entries(kinds)
              .map(([kind, n]) => `${kindLabels[kind as keyof typeof kinds]}: ${n.toLocaleString()} tokens`)
              .join('\n')}
          >
            <div className="flex h-2 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-900">
              {Object.entries(kinds).map(([kind, n]) => (
                <span
                  key={kind}
                  className={cx('h-full transition-[width] duration-300', kindColors[kind as keyof typeof kinds])}
                  style={{ width: `${(n / total) * 100}%` }}
                />
              ))}
            </div>
          </Tooltip>
          <div className="flex flex-wrap gap-3 text-zinc-500">
            {Object.entries(kinds).map(([kind, n]) => (
              <span key={kind} className="inline-flex items-center gap-1">
                <span className={cx('size-2 rounded-sm', kindColors[kind as keyof typeof kinds])} />
                {kind} {formatTokens(n)}
              </span>
            ))}
          </div>
        </div>
      )}
      {heavy.length > 0 && (
        <ol className="space-y-0.5">
          {heavy.map(tool => (
            <li key={tool.call.id} className="flex items-center gap-2">
              <span className="font-mono">{tool.call.tool.replace(/^bothub_/, '')}</span>
              <span className="min-w-0 truncate font-mono text-zinc-500">
                {toolSummary(tool.call.tool, tool.call.input)}
              </span>
              <Tooltip className="ml-auto" tip="Result tokens, times the later calls that read it again">
                <span className="text-zinc-500 tabular-nums">
                  {formatTokens(tokensOf(tool.resultChars))} x{tool.carried}
                </span>
              </Tooltip>
            </li>
          ))}
        </ol>
      )}
      <ol className="space-y-0.5">
        {runs.map(run => {
          const cost = costOf(run.tally, run.model, prices);
          return (
            <li key={run.id} className="flex items-center gap-2">
              <StatusIcon status={run.status} level="job" className="size-3" />
              <span>{run.check ?? `attempt ${run.attempt ?? 1}`}</span>
              <span className="ml-auto flex items-center gap-3">
                <Io tally={run.tally} />
                <Cost billed={cost.billed} estimated={cost.estimated} tally={run.tally} className="w-14 justify-end" />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

/** The run whose job execution a view shows, and which of its runs should stream: the newest live one. */
export const executionOf = (rows: RunRow[], id: string) => {
  const byId = new Map(rows.map(r => [r.id, r]));
  const run = byId.get(id);
  if (!run) return;
  const root = rootOf(run, byId);
  const attempts = attemptsOf(root, rows);
  const runs = attempts.flatMap(a => [a, ...[...checksOf(a, rows).values()].flat()]);
  const stream = runs.filter(r => isLive(r.status)).at(-1) ?? run;
  return { run, root, attempts, runs, stream };
};

const pinnedSlack = 48;

/** A run id the run list does not have, with where the list comes from and the way back to it. */
const Missing = ({ id }: { id: string }) => {
  const info = useAtomValue(infoAtom);
  const navigate = useSetAtom(navigateAtom);
  return (
    <div className="space-y-2 p-4 text-sm text-zinc-600 dark:text-zinc-400">
      <p>
        Run <code className="font-mono">{id}</code> is not in{' '}
        {info ? <code className="font-mono">{info.dataReal ?? info.data}</code> : 'this data directory'}.
      </p>
      <button
        type="button"
        className="underline"
        onClick={() => navigate({ path: '/dashboard', query: { run: null } })}
      >
        Back to the run list
      </button>
    </div>
  );
};

/**
 * A job execution as GitHub Actions-like steps: each attempt with its model and tool calls, then its checks, then
 * the outcome. Live and failed steps start open; the view keeps to the bottom while live unless scrolled up.
 */
export const RunView = ({ id, page, follow }: { id: string; page?: boolean; follow?: boolean }) => {
  const rows = useAtomValue(runRowsAtom);
  const prices = useAtomValue(pricesAtom);
  const followed = useAtomValue(followedAtom);
  const navigate = useSetAtom(navigateAtom);
  const [mode, setMode] = useState<Mode>('auto');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const toggle = useCallback((step: string, open: boolean) => setOverrides(o => ({ ...o, [step]: open })), []);
  const steps = useMemo(() => ({ mode, overrides, toggle }), [mode, overrides, toggle]);
  const execution = useMemo(() => (rows ? executionOf(rows, id) : undefined), [rows, id]);
  const live = execution?.runs.some(r => isLive(r.status)) ?? false;
  const streamed = followed?.records.length ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned && live) el.scrollTop = el.scrollHeight;
  }, [streamed, pinned, live, execution]);

  if (!rows) return <p className="p-4 text-zinc-500">Loading runs.</p>;
  if (!execution)
    return follow ? <p className="p-4 text-zinc-500">Waiting for a run to start.</p> : <Missing id={id} />;
  const { run, root, attempts, runs } = execution;
  const last = attempts.at(-1)!;
  const setAll = (next: Mode) => {
    setMode(next);
    setOverrides({});
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        {page && (
          <Tooltip tip="Back to the run list">
            <Button
              variant="small"
              aria-label="Back to the run list"
              onClick={() => navigate({ path: '/dashboard', query: { run: run.id } })}
            >
              <Icon name="chevron" className="size-3 rotate-180" />
            </Button>
          </Tooltip>
        )}
        <StatusIcon status={last.status} level="job" />
        <span className="font-medium">
          {root.workflow} / {root.job}
        </span>
        <span className="min-w-0 truncate text-zinc-500">
          {run.event.number !== undefined && `#${run.event.number} `}
          {eventTitle(run.event)}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Tooltip tip="Expand every step">
            <Button variant="small" aria-label="Expand all" onClick={() => setAll('all')}>
              <Icon name="expand" className="size-3" />
            </Button>
          </Tooltip>
          <Tooltip tip="Collapse every step">
            <Button variant="small" aria-label="Collapse all" onClick={() => setAll('none')}>
              <Icon name="collapse" className="size-3" />
            </Button>
          </Tooltip>
          <Tooltip
            tip={follow ? 'Following the latest run; click to stay on this one' : 'Follow the latest run as runs start'}
          >
            <Button
              variant="small"
              aria-label="Follow the latest run"
              aria-pressed={!!follow}
              className={cx(follow && 'border-sky-400 text-sky-700 dark:border-sky-600 dark:text-sky-300')}
              onClick={() =>
                navigate({
                  path: follow ? `/dashboard/runs/${encodeURIComponent(run.id)}` : '/dashboard/follow',
                  query: {},
                })
              }
            >
              <Icon name="follow" className="size-3" />
            </Button>
          </Tooltip>
          {!page && (
            <Tooltip tip="Open this run on its own page">
              <Button
                variant="small"
                aria-label="Open as its own page"
                onClick={() => navigate({ path: `/dashboard/runs/${encodeURIComponent(run.id)}` })}
              >
                <Icon name="open" className="size-3" />
              </Button>
            </Tooltip>
          )}
        </span>
      </header>
      <div
        ref={scroller}
        onScroll={e => {
          const el = e.currentTarget;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - pinnedSlack;
          if (atBottom !== pinned) setPinned(atBottom);
        }}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        <Steps value={steps}>
          <ul>
            <Step
              id="run"
              auto={false}
              head={
                <Row>
                  <Tooltip tip="The run record: ids, harness, model, timing">
                    <Icon name="file" className="size-3.5 text-zinc-400" />
                  </Tooltip>
                  <span className="font-medium">run</span>
                  <span className="truncate text-zinc-500">{run.id}</span>
                </Row>
              }
            >
              {() => (
                <div className="py-1 pr-2 text-xs">
                  <RunFields run={run} />
                </div>
              )}
            </Step>
            <Step
              id="cost"
              auto={false}
              head={
                <Row>
                  <Tooltip tip="Where the tokens and cost of this job went">
                    <Icon name="cost" className="size-3.5 text-zinc-400" />
                  </Tooltip>
                  <span className="font-medium">cost</span>
                </Row>
              }
            >
              {() => (
                <Breakdown
                  runs={runs}
                  records={followed && runs.some(r => r.id === followed.id) ? followed.records : []}
                  prices={prices}
                />
              )}
            </Step>
            {attempts.map(attempt => (
              <AttemptStep key={attempt.id} attempt={attempt} total={attempts.length} runs={rows} prices={prices} />
            ))}
            <OutcomeStep run={last} />
          </ul>
        </Steps>
      </div>
      {!pinned && live && (
        <button
          type="button"
          onClick={() => {
            setPinned(true);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
          }}
          className="absolute right-4 bottom-4 inline-flex items-center gap-1 rounded-full bg-sky-600 px-3 py-1 text-xs text-white shadow-md hover:bg-sky-700"
        >
          <Icon name="latest" className="size-3" />
          Latest
        </button>
      )}
    </div>
  );
};
