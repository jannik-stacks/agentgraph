import { useAtomValue, useSetAtom } from 'jotai';
import {
  createContext,
  memo,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { RunRow } from '../../../src/live.ts';
import { extractProposals, proseLine } from '../../../src/outputs.ts';
import type { EventRecord } from '../../../src/store.ts';
import { estimate, type Price, tokensOf } from '../../../src/usage.ts';
import { eventIdAtom, infoAtom, navigateAtom, runIdAtom, runPageAtom } from '../state.ts';
import { Icon } from '../studio/icons.tsx';
import { Link } from '../Providers.tsx';
import { cx, Disclosure, IconButton, Tooltip } from '../ui.tsx';
import { Ago, Amount, Cost, Elapsed, formatTokens, Io, paneHeader, Running, StatusIcon, useEnter } from './bits.tsx';
import { fetchEvents, fetchOutcome, live, pricesAtom, recordKey } from './live.ts';
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
import { DiffFiles, DiffSummary, WhitespaceToggle } from './DiffView.tsx';
import { CheckLines, FetchedFindings, VerdictIcon } from './EventView.tsx';
import { fetchRunDiff, hideWhitespaceAtom } from './pulls.ts';
import { AnswerBox } from './Review.tsx';
import {
  OutcomeView,
  ProposalView,
  Raw,
  RawToggle,
  RunFields,
  Text,
  ToolBody,
  toolName,
  toolSummary,
} from './render/index.tsx';
import { DecidedHead, DecidedRows, decisionsOf } from './render/decisions.tsx';
import { RecalledHead, RecalledRows, recallsOf } from './render/recall.tsx';

type Mode = 'auto' | 'all' | 'none';
const Steps = createContext<{
  isOpen: (id: string, auto: boolean, stay: boolean) => boolean;
  toggle: (id: string, open: boolean) => void;
}>({ isOpen: (_id, auto) => auto, toggle: () => {} });

/**
 * A collapsible step. Its body renders only while open; `auto` says whether it starts open. `head` may depend on
 * whether the step is open, so a running step can hand its spinner down to the step inside it. `actions` sit at the end
 * of the head's line while open, in a slot every step keeps so their columns line up. `fresh` is the key whose first
 * arrival animates the step in. With `stay`, a step that opened on its own stays open after `auto` turns false, so a
 * run that finishes does not fold away under the reader.
 */
const Step = ({
  id,
  auto,
  head,
  actions,
  children,
  depth = 0,
  fresh = '',
  stay = false,
}: {
  id: string;
  auto: boolean;
  head: ReactNode | ((open: boolean) => ReactNode);
  actions?: ReactNode;
  children: () => ReactNode;
  depth?: number;
  fresh?: string;
  stay?: boolean;
}) => {
  const { isOpen, toggle } = useContext(Steps);
  const enter = useEnter(fresh);
  const open = isOpen(id, auto, stay);
  return (
    <li className={cx('[contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]', enter)}>
      <div className="flex items-center rounded pr-1 hover:bg-zinc-50 dark:hover:bg-zinc-900">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggle(id, !open)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-1 text-left text-xs"
          style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
        >
          <Icon name="chevron" className={cx('size-3 text-zinc-400 transition-transform', open && 'rotate-90')} />
          {typeof head === 'function' ? head(open) : head}
        </button>
        <span className="flex w-5 shrink-0 justify-center">{open && actions}</span>
      </div>
      {open && <div style={{ paddingLeft: `${1.5 + depth * 1}rem` }}>{children()}</div>}
    </li>
  );
};

const Aside = ({ className, children }: { className?: string; children: ReactNode }) => (
  <li className={cx('flex items-center gap-2 px-2 py-1 text-xs', className ?? 'text-zinc-500')}>{children}</li>
);

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
  const [raw, setRaw] = useState(false);
  return (
    <Step
      id={tool.call.id}
      auto={failed}
      depth={depth}
      fresh={recordKey(runId, tool.seq)}
      actions={<RawToggle raw={raw} onToggle={() => setRaw(!raw)} />}
      head={
        <Row>
          <StatusIcon
            kind="tool"
            status={!tool.result ? 'running' : failed ? 'failed' : 'succeeded'}
            className="size-3"
            tip={!tool.result ? 'Tool running' : failed ? 'Tool failed' : 'Tool call'}
          />
          <span className="font-mono">{toolName(tool.call.tool)}</span>
          <span className="min-w-0 truncate font-mono text-zinc-500">
            {toolSummary(tool.call.tool, tool.call.input)}
          </span>
          {!tool.result && <span className="shrink-0 text-sky-700 dark:text-sky-300">running</span>}
          <Right>
            <Tooltip
              tip={`Result: ${tool.resultChars.toLocaleString()} characters, about ${formatTokens(cost.result)} tokens\nRead again by ${tool.carried} later ${tool.carried === 1 ? 'call' : 'calls'}: ${formatTokens(cost.carried)} tokens in all`}
            >
              <span className="inline-flex items-center text-fd-muted-foreground tabular-nums">
                <Amount value={cost.carried || cost.result} glyph="in" />
                {tool.carried > 1 && <span className="ml-0.5">x{tool.carried}</span>}
              </span>
            </Tooltip>
            <Tooltip
              tip={`Arguments: ${tool.argChars.toLocaleString()} characters, about ${formatTokens(cost.args)} tokens`}
            >
              <span className="text-fd-muted-foreground tabular-nums">
                <Amount value={cost.args} glyph="out" />
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
            raw={raw}
            {...(tool.result?.output !== undefined && { output: tool.result.output })}
            {...(tool.result && { ok: tool.result.ok })}
          />
        </div>
      )}
    </Step>
  );
});

/** The first line a turn said, past any code fence, else the tools it called. */
const turnSummary = (turn: Turn) =>
  (turn.texts[0] && proseLine(turn.texts[0].text)?.slice(0, 120)) ??
  (turn.texts.length ? 'proposals' : turn.tools.map(t => toolName(t.call.tool)).join(', '));

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
          {live && !open && <StatusIcon status="running" className="size-3" tip="The model is working" />}
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
              <Text text={t.text} fences={fences} />
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

/** The bottom of a live transcript: the run is still going, and how long since its last event. */
const Working = ({ run, records }: { run: RunRow; records: EventRecord[] }) => {
  const last = records.at(-1)!;
  const waiting = last.event.type === 'tool_call' ? 'a tool' : 'the model';
  return (
    <li className="flex items-center gap-2 px-2 py-1 pl-7 text-xs text-sky-800 dark:text-sky-200">
      <StatusIcon status={run.status} className="size-3" tip="The run is working" />
      <span>waiting for {waiting}</span>
      <Tooltip tip="Time since the run's last event; most harnesses report a step only once it is done">
        <span className="text-zinc-500">
          last event <Ago at={last.ts} />
        </span>
      </Tooltip>
    </li>
  );
};

/** A proposals block in a bot's message, parsed the way the hub reads it, as one line that opens to the proposals. */
const ProposalsFence = ({ code }: { code: string }) => {
  const { proposals, errors } = extractProposals(`\`\`\`bothub\n${code}\n\`\`\``);
  return (
    <Disclosure
      className="not-prose my-1.5 text-xs"
      summaryClassName="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
      summary={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Icon name="file" className="size-3" />
          <span>
            proposes{' '}
            <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
              {proposals.map(p => p.kind).join(', ') || 'nothing'}
            </span>
          </span>
          {errors.length > 0 && <span className="text-red-600 dark:text-red-400">{errors.length} unreadable</span>}
        </span>
      }
    >
      <div className="mt-1.5 space-y-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
        {proposals.map((proposal, i) => (
          <ProposalView key={i} proposal={proposal} />
        ))}
        {errors.map((error, i) => (
          <p key={i} className="text-red-600 dark:text-red-400">
            {error}
          </p>
        ))}
      </div>
    </Disclosure>
  );
};

const fences = { bothub: (code: string) => <ProposalsFence code={code} /> };

/** A run's model calls and tool calls as steps; the last one stays open while the run is live. */
const Transcript = ({ run, records, price }: { run: RunRow; records: EventRecord[]; price: Price | undefined }) => {
  const { turns, start, end, errors } = useMemo(() => turnsOf(records), [records]);
  const recalls = useMemo(() => recallsOf(records), [records]);
  const decisions = useMemo(() => decisionsOf(records), [records]);
  const live = isLive(run.status);
  const first = turns.find(t => t.usage)?.usage;
  return (
    <ul className="py-0.5">
      {start?.model && start.model !== run.model && (
        <Aside>
          <Tooltip tip="Model the harness reported">
            <Icon name="model" className="size-3" />
          </Tooltip>
          <span>{start.model}</span>
        </Aside>
      )}
      {first && (
        <Aside>
          <Tooltip tip="Setup: the first call's input, system prompt, preloaded notes, task and tool definitions">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="file" className="size-3 text-zinc-400" />
              setup
              <span className="text-fd-muted-foreground tabular-nums">
                <Amount value={first.inputTokens} glyph="in" />
              </span>
            </span>
          </Tooltip>
        </Aside>
      )}
      {recalls.length > 0 && (
        <Step id={`${run.id}:recalled`} auto={false} head={<RecalledHead recalls={recalls} />}>
          {() => <RecalledRows recalls={recalls} />}
        </Step>
      )}
      {decisions.length > 0 && (
        <Step id={`${run.id}:decided`} auto={false} head={<DecidedHead decisions={decisions} />}>
          {() => <DecidedRows decisions={decisions} />}
        </Step>
      )}
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
      {live && records.length > 0 && <Working run={run} records={records} />}
      {errors.map((message, i) => (
        <Aside key={i} className="text-red-600 dark:text-red-400">
          {message}
        </Aside>
      ))}
      {end && (!end.ok || end.turns !== undefined) && (
        <Aside>
          {!end.ok && <StatusIcon status="failed" tip="The harness failed" />}
          {end.ok ? `finished after ${end.turns} turns` : 'the harness failed'}
        </Aside>
      )}
      {!records.length && (
        <Aside>
          {live && <StatusIcon status={run.status} className="size-3" />}
          {live ? 'Waiting for the first event.' : 'No events.'}
        </Aside>
      )}
    </ul>
  );
};

const FetchedTranscript = ({ run, price }: { run: RunRow; price: Price | undefined }) => (
  <Transcript run={run} records={use(fetchEvents(run.id, run.status))} price={price} />
);

/** The records of `run`: streamed when it is the followed run, fetched once otherwise. */
const RunTranscript = ({ run, prices }: { run: RunRow; prices: Prices }) => {
  const followed = useAtomValue(live.followed);
  const price = run.model ? prices[run.model] : undefined;
  if (followed?.id === run.id) return <Transcript run={run} records={followed.records} price={price} />;
  return (
    <Suspense fallback={<div className="min-h-7" />}>
      <FetchedTranscript run={run} price={price} />
    </Suspense>
  );
};

/** The transcript's step head: who ran it on which model, and its totals. Open, it leaves the spinner to the call inside. */
const TranscriptHead = ({ run, prices, open }: { run: RunRow; prices: Prices; open: boolean }) => {
  const cost = costOf(run.tally, run.model, prices);
  return (
    <Row>
      <StatusIcon status={run.status} level={open && run.status === 'running' ? 'job' : 'run'} />
      <span className="font-medium">transcript</span>
      <span className="truncate text-zinc-500">{[run.bot, run.model].filter(Boolean).join(', ')}</span>
      <Right>
        <Elapsed startedAt={run.startedAt} endedAt={run.endedAt ?? (isLive(run.status) ? undefined : run.startedAt)} />
        <Io tally={run.tally} />
        <Cost billed={cost.billed} estimated={cost.estimated} tally={run.tally} className="w-12 justify-end" />
      </Right>
    </Row>
  );
};

const TranscriptStep = ({ run, prices, auto }: { run: RunRow; prices: Prices; auto: boolean }) => (
  <Step
    id={`${run.id}:transcript`}
    fresh={`run:${run.id}`}
    stay
    auto={auto}
    head={open => <TranscriptHead run={run} prices={prices} open={open} />}
  >
    {() => <RunTranscript run={run} prices={prices} />}
  </Step>
);

const useOutcome = (run: RunRow) => {
  const followed = useAtomValue(live.followed);
  return followed?.id === run.id ? followed.outcome : undefined;
};

/** The verdict a check run's check gave its attempt: one line, then its findings. */
const VerdictStep = ({ attempt, name, runs }: { attempt: RunRow; name: string; runs: RunRow[] }) => {
  const brief = attempt.brief?.checks?.find(v => v.check === name);
  if (!brief) return null;
  return (
    <li className="space-y-1 px-2 py-1 text-xs">
      <div className="flex min-w-0 items-center gap-2 pl-5">
        <VerdictIcon attempt={attempt} name={name} runs={runs} />
        <span className="font-medium">verdict</span>
        <span className="shrink-0 text-zinc-500">
          {brief.skipped ? 'skipped' : brief.pass ? 'passed' : 'failed'}
          {!brief.gating && ', log only'}
        </span>
        <Suspense fallback={null}>
          <FetchedFindings attempt={attempt} name={name} line />
        </Suspense>
      </div>
      <div className="pl-10 empty:hidden">
        <Suspense fallback={null}>
          <FetchedFindings attempt={attempt} name={name} />
        </Suspense>
      </div>
    </li>
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
      head={open => (
        <Row>
          <Tooltip tip={run.brief?.applied ? 'What the run proposed was applied' : 'Nothing was applied'}>
            <Icon name={run.brief?.applied ? 'ok' : 'skipped'} className="size-3.5 text-zinc-500" />
          </Tooltip>
          <span className="font-medium">outcome</span>
          {!open && <span className="truncate text-zinc-500">{run.brief?.kinds.join(', ')}</span>}
        </Row>
      )}
    >
      {() => (
        <div className="space-y-2 py-1 pr-2">
          {streamed ? (
            <OutcomeView outcome={streamed} />
          ) : (
            <Suspense fallback={null}>
              <FetchedOutcome run={run} />
            </Suspense>
          )}
          <AnswerBox run={run} />
        </div>
      )}
    </Step>
  );
};

/** Whether a run left commits behind: pushed them, or parked its work on a branch. */
const committed = (run: RunRow) =>
  !!run.parked || !!run.brief?.results.some(r => r.kind === 'push' && r.status === 'applied');

const FetchedDiff = ({ run }: { run: RunRow }) => {
  const hide = useAtomValue(hideWhitespaceAtom);
  const diff = use(fetchRunDiff(run.id, run.status, hide));
  if (!diff?.files.length && !diff?.hiddenFiles)
    return <p className="text-xs text-zinc-500">This run changed no files.</p>;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <DiffSummary files={diff.files} />
        <WhitespaceToggle />
      </div>
      <DiffFiles files={diff.files} hiddenFiles={diff.hiddenFiles} />
    </div>
  );
};

/** The diff a run pushed or parked, with a link to the merge request on its branch. */
const ChangesStep = ({ run }: { run: RunRow }) => {
  const pulls = useAtomValue(live.pulls);
  if (!committed(run)) return null;
  const branch = run.parked ?? run.brief?.branch;
  const pull =
    run.brief?.pr !== undefined
      ? pulls.find(p => p.number === run.brief?.pr)
      : pulls.find(p => p.branch === branch && p.state === 'open');
  return (
    <Step
      id={`${run.id}:changes`}
      auto={false}
      head={
        <Row>
          <Tooltip tip={run.parked ? `Work parked on ${run.parked}` : 'Files this run committed and pushed'}>
            <Icon name="pull" className="size-3.5 text-zinc-400" />
          </Tooltip>
          <span className="font-medium">changes</span>
          <span className="truncate font-mono text-[11px] text-zinc-500">{branch}</span>
          {pull && <span className="text-zinc-500">#{pull.number}</span>}
        </Row>
      }
    >
      {() => (
        <div className="space-y-2 py-1 pr-2">
          {pull && (
            <Link
              href={`/dashboard/pulls/${pull.number}`}
              className="inline-flex items-center gap-1.5 text-xs text-sky-700 hover:underline dark:text-sky-300"
            >
              Merge request #{pull.number}: {pull.title}
            </Link>
          )}
          <Suspense fallback={null}>
            <FetchedDiff run={run} />
          </Suspense>
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
              <span className="font-mono">{toolName(tool.call.tool)}</span>
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
              <StatusIcon
                status={run.status}
                level="job"
                {...(run.check && { kind: 'check' as const })}
                className="size-3"
              />
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

/**
 * Where a run sits: its job's attempts, the attempt it is or judges, and, for a check run, the runs of the same check
 * on that attempt.
 */
export const executionOf = (rows: RunRow[], id: string) => {
  const byId = new Map(rows.map(r => [r.id, r]));
  const run = byId.get(id);
  if (!run) return;
  const root = rootOf(run, byId);
  const attempts = attemptsOf(root, rows);
  const attempt = (run.check && run.parent ? byId.get(run.parent) : undefined) ?? run;
  const siblings = run.check ? (checksOf(attempt, rows).get(run.check) ?? [run]) : [run];
  const runs = attempts.flatMap(a => [a, ...[...checksOf(a, rows).values()].flat()]);
  return { run, root, attempts, attempt, siblings, runs };
};

const pinnedSlack = 48;

/** A run id the run list does not have, with where the list comes from and the way back to it. */
const Missing = ({ id }: { id: string }) => {
  const info = useAtomValue(infoAtom);
  const select = useSetAtom(runIdAtom);
  return (
    <div className="space-y-2 p-4 text-sm text-zinc-600 dark:text-zinc-400">
      <p>
        Run <code className="font-mono">{id}</code> is not in{' '}
        {info ? <code className="font-mono">{info.dataReal ?? info.data}</code> : 'this data directory'}.
      </p>
      <button type="button" className="underline" onClick={() => select(null)}>
        Back to the run list
      </button>
    </div>
  );
};

const crumb =
  'min-w-0 truncate rounded px-1 hover:bg-zinc-100 hover:text-sky-700 dark:hover:bg-zinc-800 dark:hover:text-sky-300';

const Sep = () => (
  <span aria-hidden className="shrink-0 px-0.5 text-zinc-300 select-none dark:text-zinc-600">
    /
  </span>
);

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

const stepButton =
  'inline-flex h-full items-center px-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-200';

/**
 * `noun i/n` in one pill between buttons to the one before and after, also on `keys`; the count selects the current one
 * when `onOpen` is given.
 */
const Stepper = ({
  noun,
  list,
  at,
  keys,
  onOpen,
}: {
  noun: string;
  list: RunRow[];
  at: number;
  keys: [string, string];
  onOpen?: (() => void) | undefined;
}) => {
  const select = useSetAtom(runIdAtom);
  const go = useEffectEvent((step: number) => {
    const next = list[at + step];
    if (next) select(next.id);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === keys[0]) go(-1);
      else if (e.key === keys[1]) go(1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [keys]);
  const label = (
    <span className="px-1 tabular-nums">
      {noun} {at + 1}/{list.length}
    </span>
  );
  return (
    <span
      role="group"
      aria-label={`${noun}s`}
      className="inline-flex h-5 shrink-0 items-center overflow-hidden rounded-full border border-zinc-200 dark:border-zinc-700"
    >
      <Tooltip action={`Previous ${noun}`} keys={keys[0]} className="h-full">
        <button
          type="button"
          aria-label={`Previous ${noun}`}
          className={cx(stepButton, 'pl-1.5')}
          disabled={at === 0}
          onClick={() => go(-1)}
        >
          <Icon name="left" className="size-3" />
        </button>
      </Tooltip>
      {onOpen ? (
        <Tooltip action={`Show this ${noun}`} className="h-full">
          <button type="button" className={cx(stepButton, 'text-zinc-700 dark:text-zinc-300')} onClick={onOpen}>
            {label}
          </button>
        </Tooltip>
      ) : (
        label
      )}
      <Tooltip action={`Next ${noun}`} keys={keys[1]} className="h-full">
        <button
          type="button"
          aria-label={`Next ${noun}`}
          className={cx(stepButton, 'pr-1.5')}
          disabled={at === list.length - 1}
          onClick={() => go(1)}
        >
          <Icon name="right" className="size-3" />
        </button>
      </Tooltip>
    </span>
  );
};

const attemptKeys: [string, string] = ['[', ']'];
const runKeys: [string, string] = ['j', 'k'];

/** Where the shown run sits: event, job, attempt, check and check run, each a way to the view above it. */
const Crumbs = ({ execution }: { execution: NonNullable<ReturnType<typeof executionOf>> }) => {
  const { run, root, attempts, attempt, siblings } = execution;
  const select = useSetAtom(runIdAtom);
  const selectEvent = useSetAtom(eventIdAtom);
  const at = attempts.indexOf(attempt);
  const onJob = !run.check && attempt === attempts.at(-1);
  return (
    <nav aria-label="Where this run sits" className="flex min-w-0 flex-1 items-center gap-0.5">
      <Tooltip
        tip={`Event: ${run.event.trigger}${run.event.action ? ` ${run.event.action}` : ''}`}
        action="Show the event and all its jobs"
        className="min-w-0"
      >
        <button type="button" className={cx(crumb, 'text-zinc-500')} onClick={() => selectEvent(run.event.id)}>
          {run.event.number !== undefined && `#${run.event.number} `}
          {eventTitle(run.event)}
        </button>
      </Tooltip>
      <Sep />
      <Tooltip
        tip={`Job ${root.job} in workflow ${root.workflow}`}
        {...(!onJob && { action: 'Show its latest attempt' })}
        className="shrink-0"
      >
        {onJob ? (
          <span className="px-1 font-medium">{root.job}</span>
        ) : (
          <button type="button" className={cx(crumb, 'font-medium')} onClick={() => select(attempts.at(-1)!.id)}>
            {root.job}
          </button>
        )}
      </Tooltip>
      {attempts.length > 1 && (
        <>
          <Sep />
          <Stepper
            noun="attempt"
            list={attempts}
            at={at}
            keys={attemptKeys}
            {...(run.check && { onOpen: () => select(attempt.id) })}
          />
        </>
      )}
      {run.check && (
        <>
          <Sep />
          <span className="shrink-0 px-1 font-medium">{run.check}</span>
          {siblings.length > 1 && <Stepper noun="run" list={siblings} at={siblings.indexOf(run)} keys={runKeys} />}
        </>
      )}
    </nav>
  );
};

/**
 * One run, with its place shown above it. An attempt shows its record, its cost, its transcript, the checks that judged
 * it, its outcome and its changes; a check run shows its verdict, its transcript and its record. Live and failed steps
 * start open; the view keeps to the bottom while live unless scrolled up.
 */
export const RunView = ({
  id,
  variant = 'panel',
  onClose,
}: {
  id: string;
  variant?: 'panel' | 'page' | 'follow';
  onClose?: (() => void) | undefined;
}) => {
  const follow = variant === 'follow';
  const rows = useAtomValue(live.rows);
  const prices = useAtomValue(pricesAtom);
  const followed = useAtomValue(live.followed);
  const navigate = useSetAtom(navigateAtom);
  const select = useSetAtom(runIdAtom);
  const setRunPage = useSetAtom(runPageAtom);
  const [mode, setMode] = useState<Mode>('auto');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState(true);
  const [rawRecord, setRawRecord] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const toggle = useCallback((step: string, open: boolean) => setOverrides(o => ({ ...o, [step]: open })), []);
  const opened = useRef(new Set<string>());
  const steps = useMemo(
    () => ({
      isOpen: (step: string, auto: boolean, stay: boolean) => {
        if (stay && auto) opened.current.add(step);
        const fallback = stay ? opened.current.has(step) : auto;
        return overrides[step] ?? (mode === 'all' ? true : mode === 'none' ? false : fallback);
      },
      toggle,
    }),
    [mode, overrides, toggle]
  );
  const execution = useMemo(() => (rows ? executionOf(rows, id) : undefined), [rows, id]);
  const running = execution ? isLive(execution.run.status) : false;
  const streamed = followed?.records.length ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned && running) el.scrollTop = el.scrollHeight;
  }, [streamed, pinned, running, execution]);

  if (!rows) return <p className="p-4 text-zinc-500">Loading runs.</p>;
  if (!execution)
    return follow ? <p className="p-4 text-zinc-500">Waiting for a run to start.</p> : <Missing id={id} />;
  const { run, attempt, siblings, runs } = execution;
  const setAll = (next: Mode) => {
    setMode(next);
    setOverrides({});
  };
  const record = (
    <Step
      id="run"
      auto={false}
      actions={<RawToggle raw={rawRecord} onToggle={() => setRawRecord(!rawRecord)} />}
      head={
        <Row>
          <Icon name="file" className="size-3.5 text-zinc-400" />
          <Tooltip tip="What the hub stored about this run in run.json: job, bot, event, timing and ids">
            <span className="font-medium">record</span>
          </Tooltip>
          <span className="truncate text-zinc-500">run.json</span>
        </Row>
      }
    >
      {() => <div className="py-1 pr-2 pl-5 text-xs">{rawRecord ? <Raw value={run} /> : <RunFields run={run} />}</div>}
    </Step>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className={paneHeader}>
        {(variant === 'page' || follow) && (
          <IconButton
            tip="Back to the run list"
            onClick={() => {
              setRunPage(false);
              if (follow) select(run.id);
            }}
          >
            <Icon name="left" className="size-3" />
          </IconButton>
        )}
        {!running && <StatusIcon status={run.status} level="job" />}
        <Crumbs execution={execution} />
        {running && <Running run={run} />}
        <span className="flex shrink-0 items-center gap-1">
          <IconButton tip="Expand every step" onClick={() => setAll('all')}>
            <Icon name="expand" className="size-3" />
          </IconButton>
          <IconButton tip="Collapse every step" onClick={() => setAll('none')}>
            <Icon name="collapse" className="size-3" />
          </IconButton>
          <IconButton
            tip={follow ? 'Stay on this run' : 'Follow the latest run as runs start'}
            aria-pressed={!!follow}
            className={cx(follow && 'border-sky-400 text-sky-700 dark:border-sky-600 dark:text-sky-300')}
            onClick={() => (follow ? select(run.id) : navigate({ path: '/dashboard/follow' }))}
          >
            <Icon name="follow" className="size-3" />
          </IconButton>
          {variant !== 'page' && !follow && (
            <IconButton tip="Open this run on its own page" onClick={() => setRunPage(true)}>
              <Icon name="open" className="size-3" />
            </IconButton>
          )}
          {onClose && (
            <IconButton tip="Close" keys="Esc" onClick={onClose}>
              <Icon name="close" className="size-3" />
            </IconButton>
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
        className="bhm-scroll-fade min-h-0 flex-1 overflow-y-auto py-1"
      >
        <Steps value={steps}>
          {run.check ? (
            <ul>
              <VerdictStep attempt={attempt} name={run.check} runs={siblings} />
              <TranscriptStep run={run} prices={prices} auto />
              {record}
            </ul>
          ) : (
            <ul>
              {record}
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
              <TranscriptStep run={run} prices={prices} auto={isLive(run.status) || isFailed(run.status)} />
              <CheckLines attempt={run} rows={rows} depth={1} />
              <OutcomeStep run={run} />
              {committed(run) && <ChangesStep key={run.id} run={run} />}
            </ul>
          )}
        </Steps>
      </div>
      {!pinned && running && (
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
