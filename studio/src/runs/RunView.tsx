import { useAtomValue, useSetAtom } from 'jotai';
import { type ReactNode, Suspense, use, useMemo, useState } from 'react';
import type { RunRow } from '../../../src/live.ts';
import { extractProposals, proseLine } from '../../../src/outputs.ts';
import { estimate, type Price } from '../../../src/usage.ts';
import { Icon } from '../icons.tsx';
import { infoAtom, runIdAtom } from '../state.ts';
import { accent, Button, cx, Disclosure, Link } from '../ui.tsx';
import { Cost, Io, PhaseWord, Took } from './bits.tsx';
import { DiffFiles, DiffSummary, WhitespaceToggle } from './DiffView.tsx';
import { fetchEvents, fetchOutcome, live, pricesAtom } from './live.ts';
import {
  attemptsOf,
  checksOf,
  costOf,
  eventTitle,
  isLive,
  phaseOf,
  type Prices,
  rootOf,
  type ToolStep,
  type Turn,
  turnsOf,
} from './model.ts';
import { fetchRunDiff, hideWhitespaceAtom } from './pulls.ts';
import { AnswerBox, post } from './Review.tsx';
import { Raw, RawToggle, Text } from './render/core.tsx';
import { DecidedHead, DecidedRows, decisionsOf } from './render/decisions.tsx';
import { FindingsLine, OutcomeView, ProposalView, RunFields, VerdictView } from './render/outcome.tsx';
import { RecalledHead, RecalledRows, recallsOf } from './render/recall.tsx';
import { ToolBody, toolName, toolSummary } from './render/tools.tsx';

/** A folding step of a run: one line that opens to its body, which renders only while open. */
const Step = ({
  head,
  open = false,
  actions,
  children,
}: {
  head: ReactNode;
  open?: boolean;
  actions?: ReactNode;
  children: () => ReactNode;
}) => {
  const [shown, setShown] = useState(open);
  return (
    <li>
      <div className="flex items-center rounded pr-1 hover:bg-zinc-50 dark:hover:bg-zinc-900">
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => setShown(!shown)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-1 pl-2 text-left text-xs"
        >
          <Icon name="chevron" className={cx('size-3 text-zinc-400', shown && 'rotate-90')} />
          {head}
        </button>
        {shown && actions}
      </div>
      {shown && <div className="pb-1 pl-6">{children()}</div>}
    </li>
  );
};

const Row = ({ children }: { children: ReactNode }) => (
  <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
);

const Right = ({ children }: { children: ReactNode }) => (
  <span className="ml-auto flex shrink-0 items-center gap-3">{children}</span>
);

const Aside = ({ children, on = false }: { children: ReactNode; on?: boolean }) => (
  <li className={cx('px-2 py-1 pl-7 text-xs', on ? accent.text : 'text-zinc-500')}>{children}</li>
);

const ToolLine = ({ tool }: { tool: ToolStep }) => {
  const failed = tool.result?.ok === false;
  const [raw, setRaw] = useState(false);
  return (
    <Step
      open={failed}
      actions={<RawToggle raw={raw} onToggle={() => setRaw(!raw)} />}
      head={
        <Row>
          <span className="font-mono">{toolName(tool.call.tool)}</span>
          <span className="min-w-0 truncate font-mono text-zinc-500">
            {toolSummary(tool.call.tool, tool.call.input)}
          </span>
          {(failed || !tool.result) && <PhaseWord phase={failed ? 'failed' : 'running'} />}
        </Row>
      }
    >
      {() => (
        <div className="pr-2">
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
};

/** A proposals block in a bot's message, parsed the way the hub reads it. */
const ProposalsFence = ({ code }: { code: string }) => {
  const { proposals, errors } = extractProposals(`\`\`\`bothub\n${code}\n\`\`\``);
  return (
    <Disclosure
      className="my-1.5 text-xs"
      summaryClassName="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
      summary={
        <span>
          proposes {proposals.map(p => p.kind).join(', ') || 'nothing'}
          {errors.length > 0 && <span className={accent.text}>, {errors.length} unreadable</span>}
        </span>
      }
    >
      <div className="mt-1.5 space-y-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
        {proposals.map((proposal, i) => (
          <ProposalView key={i} proposal={proposal} />
        ))}
        {errors.map((error, i) => (
          <p key={i} className={accent.text}>
            {error}
          </p>
        ))}
      </div>
    </Disclosure>
  );
};

const fences = { bothub: (code: string) => <ProposalsFence code={code} /> };

/** The first line a turn said, past any code fence, else the tools it called. */
const turnSummary = (turn: Turn) =>
  (turn.texts[0] && proseLine(turn.texts[0].text)?.slice(0, 120)) ??
  (turn.texts.length ? 'proposals' : turn.tools.map(t => toolName(t.call.tool)).join(', '));

const TurnLine = ({ turn, price, open }: { turn: Turn; price: Price | undefined; open: boolean }) => {
  const u = turn.usage;
  const tally = u && {
    in: u.inputTokens,
    out: u.outputTokens,
    cached: u.cachedInputTokens ?? 0,
    reasoning: u.reasoningTokens ?? 0,
  };
  return (
    <Step
      open={open || turn.tools.some(t => t.result?.ok === false)}
      head={
        <Row>
          <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">{turnSummary(turn)}</span>
          {tally && (
            <Right>
              <Io tally={tally} />
              <Cost billed={u.costUsd ?? 0} estimated={estimate(tally, price)} />
            </Right>
          )}
        </Row>
      }
    >
      {() => (
        <ul className="space-y-1">
          {turn.texts.map(t => (
            <li key={t.seq} className="pr-2">
              <Text text={t.text} fences={fences} />
            </li>
          ))}
          {turn.tools.map(tool => (
            <ToolLine key={tool.call.id} tool={tool} />
          ))}
        </ul>
      )}
    </Step>
  );
};

/** A run's model calls and tool calls; the last one starts open while the run is live. */
const Transcript = ({ run, version, price }: { run: RunRow; version: number; price: Price | undefined }) => {
  const records = use(fetchEvents(run.id, run.status, version));
  const { turns, start, end, errors } = useMemo(() => turnsOf(records), [records]);
  const recalls = useMemo(() => recallsOf(records), [records]);
  const decisions = useMemo(() => decisionsOf(records), [records]);
  const running = isLive(run.status);
  return (
    <ul>
      {start?.model && start.model !== run.model && <Aside>model {start.model}</Aside>}
      {recalls.length > 0 && (
        <Step head={<RecalledHead recalls={recalls} />}>{() => <RecalledRows recalls={recalls} />}</Step>
      )}
      {decisions.length > 0 && (
        <Step head={<DecidedHead decisions={decisions} />}>{() => <DecidedRows decisions={decisions} />}</Step>
      )}
      {turns.map((turn, i) => (
        <TurnLine key={turn.index} turn={turn} price={price} open={running && i === turns.length - 1} />
      ))}
      {errors.map((message, i) => (
        <Aside key={i} on>
          {message}
        </Aside>
      ))}
      {end && (
        <Aside on={!end.ok}>
          {end.ok ? `finished after ${end.turns ?? turns.length} turns` : 'the harness failed'}
        </Aside>
      )}
      {!records.length && <Aside>{running ? 'No events yet.' : 'No events.'}</Aside>}
    </ul>
  );
};

/** The transcript as fetched when the run last changed status; a running run can fetch it again. */
const TranscriptStep = ({ run, prices, open }: { run: RunRow; prices: Prices; open: boolean }) => {
  const [version, setVersion] = useState(0);
  const cost = costOf(run.tally, run.model, prices);
  return (
    <Step
      open={open}
      actions={
        isLive(run.status) && (
          <Button variant="small" onClick={() => setVersion(v => v + 1)}>
            Refresh
          </Button>
        )
      }
      head={
        <Row>
          <span className="font-medium">transcript</span>
          <span className="truncate text-zinc-500">{[run.bot, run.model].filter(Boolean).join(', ')}</span>
          <Right>
            <Io tally={run.tally} />
            <Cost billed={cost.billed} estimated={cost.estimated} />
          </Right>
        </Row>
      }
    >
      {() => (
        <Suspense fallback={<p className="py-1 text-xs text-zinc-500">Loading.</p>}>
          <Transcript run={run} version={version} price={run.model ? prices[run.model] : undefined} />
        </Suspense>
      )}
    </Step>
  );
};

const RecordStep = ({ run }: { run: RunRow }) => {
  const [raw, setRaw] = useState(false);
  return (
    <Step
      actions={<RawToggle raw={raw} onToggle={() => setRaw(!raw)} />}
      head={
        <Row>
          <span className="font-medium">record</span>
          <span className="text-zinc-500">run.json</span>
        </Row>
      }
    >
      {() => <div className="pr-2 text-xs">{raw ? <Raw value={run} /> : <RunFields run={run} />}</div>}
    </Step>
  );
};

/** The verdict check `name` gave `attempt`, from the attempt's outcome. */
const Findings = ({ attempt, name, line = false }: { attempt: RunRow; name: string; line?: boolean }) => {
  const verdict = use(fetchOutcome(attempt.id, attempt.status))?.checks?.find(v => v.check === name);
  if (!verdict) return null;
  return line ? <FindingsLine verdict={verdict} /> : <VerdictView verdict={verdict} />;
};

const verdictWord = (brief: NonNullable<NonNullable<RunRow['brief']>['checks']>[number] | undefined) =>
  !brief ? undefined : brief.skipped ? 'skipped' : brief.pass ? 'passed' : brief.gating ? 'failed' : 'failed, log only';

/** The checks that judged `attempt`, one line each, opening to the check's findings and its runs. */
const CheckLines = ({ attempt, rows }: { attempt: RunRow; rows: RunRow[] }) => {
  const select = useSetAtom(runIdAtom);
  const checks = checksOf(attempt, rows);
  for (const verdict of attempt.brief?.checks ?? []) if (!checks.has(verdict.check)) checks.set(verdict.check, []);
  return [...checks].map(([name, runs]) => {
    const brief = attempt.brief?.checks?.find(v => v.check === name);
    const last = runs.at(-1);
    const word = last && isLive(last.status) ? undefined : verdictWord(brief);
    return (
      <Step
        key={name}
        open={brief?.gating === true && !brief.pass && !brief.skipped}
        head={
          <Row>
            <span className="font-medium">{name}</span>
            {word ? (
              <span className={cx('shrink-0', word === 'failed' ? accent.text : 'text-zinc-500')}>{word}</span>
            ) : (
              last && <PhaseWord phase={phaseOf(last)} status={last.status} />
            )}
          </Row>
        }
      >
        {() => (
          <div className="space-y-1 pr-2 text-xs">
            <Suspense fallback={null}>
              <Findings attempt={attempt} name={name} />
            </Suspense>
            {runs.map(run => (
              <button
                key={run.id}
                type="button"
                className="block text-zinc-500 underline"
                onClick={() => select(run.id)}
              >
                check run {run.id}
              </button>
            ))}
          </div>
        )}
      </Step>
    );
  });
};

const OutcomeStep = ({ run }: { run: RunRow }) => {
  if (!run.brief) return null;
  return (
    <Step
      open
      head={
        <Row>
          <span className="font-medium">outcome</span>
          <span className="truncate text-zinc-500">{run.brief.kinds.join(', ')}</span>
        </Row>
      }
    >
      {() => (
        <div className="space-y-2 pr-2">
          <Suspense fallback={null}>
            <FetchedOutcome run={run} />
          </Suspense>
          <AnswerBox run={run} />
        </div>
      )}
    </Step>
  );
};

const FetchedOutcome = ({ run }: { run: RunRow }) => {
  const outcome = use(fetchOutcome(run.id, run.status));
  return outcome ? <OutcomeView outcome={outcome} /> : <p className="text-xs text-zinc-500">No outcome.</p>;
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
  const branch = run.brief?.branch ?? run.parked;
  const pull =
    run.brief?.pr !== undefined
      ? pulls.find(p => p.number === run.brief?.pr)
      : pulls.find(p => p.branch === branch && p.state === 'open');
  return (
    <Step
      head={
        <Row>
          <span className="font-medium">changes</span>
          <span className="truncate font-mono text-[11px] text-zinc-500">{branch}</span>
          {run.parked && <span className="text-zinc-500">parked</span>}
        </Row>
      }
    >
      {() => (
        <div className="space-y-2 pr-2">
          {pull && (
            <Link href={`/pulls/${pull.number}`} className="text-xs underline">
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

/** Where a run sits: its job's attempts and the attempt it is or judges. */
const executionOf = (rows: RunRow[], id: string) => {
  const byId = new Map(rows.map(r => [r.id, r]));
  const run = byId.get(id);
  if (!run) return;
  const root = rootOf(run, byId);
  const attempts = attemptsOf(root, rows);
  const attempt = (run.check && run.parent ? byId.get(run.parent) : undefined) ?? run;
  return { run, root, attempts, attempt };
};

const Missing = ({ id }: { id: string }) => {
  const info = useAtomValue(infoAtom);
  return (
    <p className="p-4 text-sm text-zinc-500">
      Run <code className="font-mono">{id}</code> is not in{' '}
      {info ? <code className="font-mono">{info.dataReal ?? info.data}</code> : 'this data directory'}.
    </p>
  );
};

const crumb = 'min-w-0 truncate hover:underline';

/** Where the shown run sits: event, job, attempt and check, each a way to the run it names. */
const Crumbs = ({ execution }: { execution: NonNullable<ReturnType<typeof executionOf>> }) => {
  const { run, root, attempts, attempt } = execution;
  const select = useSetAtom(runIdAtom);
  return (
    <nav aria-label="Where this run sits" className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="min-w-0 truncate text-zinc-500">
        {run.event.number !== undefined && `#${run.event.number} `}
        {eventTitle(run.event)}
      </span>
      /
      <button type="button" className={cx(crumb, 'font-medium')} onClick={() => select(attempts.at(-1)!.id)}>
        {root.job}
      </button>
      {attempts.length > 1 && (
        <>
          /
          {attempts.map((a, i) => (
            <button
              key={a.id}
              type="button"
              aria-current={a === attempt || undefined}
              className={cx(crumb, a === attempt ? 'font-medium' : 'text-zinc-500')}
              onClick={() => select(a.id)}
            >
              try {i + 1}
            </button>
          ))}
        </>
      )}
      {run.check && (
        <>
          /<span className="shrink-0 font-medium">{run.check}</span>
        </>
      )}
    </nav>
  );
};

/**
 * One run. An attempt shows its record, transcript, the checks that judged it, its outcome and its changes; a check
 * run shows its transcript and record. It draws again when the run's status changes.
 */
export const RunView = ({ id }: { id: string }) => {
  const rows = useAtomValue(live.rows);
  const prices = useAtomValue(pricesAtom);
  const [stopError, setStopError] = useState<string>();
  const execution = useMemo(() => (rows ? executionOf(rows, id) : undefined), [rows, id]);
  if (!rows) return null;
  if (!execution) return <Missing id={id} />;
  const { run } = execution;
  const phase = phaseOf(run);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-200 px-3 text-xs dark:border-zinc-800">
        <Crumbs execution={execution} />
        <PhaseWord phase={phase} status={run.status} />
        <Took startedAt={run.startedAt} endedAt={run.endedAt} />
        {run.status === 'running' && (
          <Button
            variant="small"
            onClick={() => void post(`/api/runs/${encodeURIComponent(run.id)}/stop`).then(setStopError)}
          >
            Stop
          </Button>
        )}
        {stopError && <span className={cx('truncate', accent.text)}>{stopError}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <ul>
          {run.check ? (
            <>
              <li className="px-2 py-1 pl-7 text-xs empty:hidden">
                <Suspense fallback={null}>
                  <Findings attempt={execution.attempt} name={run.check} />
                </Suspense>
              </li>
              <TranscriptStep run={run} prices={prices} open />
              <RecordStep run={run} />
            </>
          ) : (
            <>
              <RecordStep run={run} />
              <TranscriptStep run={run} prices={prices} open={phase === 'running' || phase === 'failed'} />
              <CheckLines attempt={run} rows={rows} />
              <OutcomeStep run={run} />
              {committed(run) && <ChangesStep run={run} />}
            </>
          )}
        </ul>
      </div>
    </div>
  );
};
