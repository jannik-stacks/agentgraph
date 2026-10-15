import type { ComponentType } from 'react';
import type { ApplyResult } from '../../../../src/apply.ts';
import { Proposal } from '../../../../src/outputs.ts';
import type { Outcome, Run, Verdict } from '../../../../src/store.ts';
import { Code } from '../../Markdown.tsx';
import { Icon } from '../../icons.tsx';
import { Badge, cx, Field, Fields, Tooltip } from '../../ui.tsx';
import { isFailed } from '../model.ts';
import { JsonView, Text, WithRaw } from './core.tsx';

type Of<K extends Proposal['kind']> = { proposal: Extract<Proposal, { kind: K }> };

const Branch = ({ name }: { name: string }) => (
  <code className="rounded bg-zinc-100 px-1 font-mono text-[11px] dark:bg-zinc-800">{name}</code>
);

const Files = ({ files }: { files: { path: string; gone?: boolean }[] }) => (
  <ul className="font-mono text-[11px]">
    {files.map(({ path, gone }) => (
      <li key={path} className={cx(gone && 'line-through')}>
        {path}
      </li>
    ))}
  </ul>
);

const Title = ({ children }: { children: string }) => <div className="font-medium">{children}</div>;

const LabelChange = ({ label, add, applied }: { label: string; add: boolean; applied: boolean }) => (
  <Tooltip
    tip={
      applied
        ? `The bot ${add ? 'added' : 'removed'} the label ${label}`
        : `The bot proposed ${add ? 'adding' : 'removing'} the label ${label}`
    }
    focusable
  >
    <span className="font-mono text-[11px] text-zinc-500">
      {add ? '+' : '−'}
      {label}
    </span>
  </Tooltip>
);

const views: { [K in Proposal['kind']]: ComponentType<Of<K> & { applied: boolean }> } = {
  reply: ({ proposal }) =>
    proposal.body.trim() ? <Text text={proposal.body} /> : <p className="text-zinc-500 italic">no reply text</p>,
  label: ({ proposal, applied }) => (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
      {proposal.add?.map(label => (
        <LabelChange key={`+${label}`} label={label} add applied={applied} />
      ))}
      {proposal.remove?.map(label => (
        <LabelChange key={`-${label}`} label={label} add={false} applied={applied} />
      ))}
    </span>
  ),
  push: ({ proposal }) => (
    <>
      <Branch name={proposal.branch} />
      {proposal.files && <Files files={proposal.files.map(path => ({ path }))} />}
    </>
  ),
  'merge-request': ({ proposal }) => (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Branch name={proposal.branch} />
        <span className="text-zinc-400">→</span>
        <Branch name={proposal.into ?? 'default'} />
        {proposal.draft && <Badge>draft</Badge>}
      </div>
      <Title>{proposal.title}</Title>
      {proposal.body && <Text text={proposal.body} />}
    </>
  ),
  merge: ({ proposal }) => <span className="font-mono">#{proposal.request}</span>,
  note: ({ proposal }) => (
    <>
      <div className="flex items-center gap-1.5">
        <Icon name="file" className="size-3.5 text-zinc-400" />
        <Badge>{proposal.note}</Badge>
        <Title>{proposal.title}</Title>
      </div>
      <Text text={proposal.body} />
    </>
  ),
  hub: ({ proposal }) => (
    <>
      <Title>{proposal.title}</Title>
      {proposal.body && <Text text={proposal.body} />}
      <Files files={proposal.files.map(f => ({ path: f.path, gone: 'delete' in f }))} />
    </>
  ),
  ask: ({ proposal }) => (
    <div className="flex gap-1.5">
      <Icon name="question" className="mt-0.5 size-3.5 text-zinc-500" />
      <Text text={proposal.question} />
    </div>
  ),
  close: ({ proposal }) => (
    <div className="flex items-start gap-1.5">
      <Badge on={waits(proposal.as)}>{proposal.as}</Badge>
      <Text text={proposal.reason} />
    </div>
  ),
};

const kindIcon: Partial<Record<Proposal['kind'], Parameters<typeof Icon>[0]['name']>> = {
  reply: 'comment',
  label: 'label',
  push: 'push',
  'merge-request': 'pull',
  merge: 'pull',
  hub: 'file',
  ask: 'question',
};

/** Whether a closure leaves the work to a human. */
const waits = (closure: string) => closure === 'blocked' || closure === 'deferred';

const inline = new Set<Proposal['kind']>(['label', 'merge']);

/** What became of a proposal: its status, the reason when it did not land, and a link to what it made. */
const ResultView = ({ result }: { result: ApplyResult }) => {
  const external = result.url && /^https?:/.test(result.url);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Tooltip
        tip={[`${result.kind} ${result.status}`, result.url && !external && result.url].filter(Boolean).join('\n')}
      >
        <Badge on={result.status === 'failed' || result.status === 'pending'}>{result.status}</Badge>
      </Tooltip>
      {external && (
        <Tooltip tip={result.url} action="Open it">
          <a
            className="inline-flex text-zinc-400 hover:text-zinc-700"
            href={result.url}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="open" className="size-3" />
          </a>
        </Tooltip>
      )}
      {result.reason && <span className="min-w-0 truncate text-zinc-500">{result.reason}</span>}
    </span>
  );
};

/** A proposal drawn for its kind, with what became of it, or its rejection reason when it was rejected. */
export const ProposalView = ({
  proposal,
  rejection,
  result,
}: {
  proposal: unknown;
  rejection?: string | undefined;
  result?: ApplyResult | undefined;
}) => {
  const parsed = Proposal.safeParse(proposal);
  if (!parsed.success)
    return (
      <div className="space-y-1">
        {rejection && <p className="text-xs text-sky-600 dark:text-sky-400">{rejection}</p>}
        <JsonView value={proposal} label="proposal" />
      </div>
    );
  const p = parsed.data;
  const View = views[p.kind] as ComponentType<{ proposal: Proposal; applied: boolean }>;
  const icon = kindIcon[p.kind];
  const body = <View proposal={p} applied={result?.status === 'applied'} />;
  return (
    <div className={cx('min-w-0 text-xs', rejection && 'rounded border-l-2 border-sky-600 pl-2 dark:border-sky-400')}>
      <WithRaw
        value={proposal}
        head={
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-zinc-500">
              {icon && <Icon name={icon} className="size-3" />}
              <span className="font-mono text-[11px]">{p.kind}</span>
            </span>
            {inline.has(p.kind) && body}
            {result && <ResultView result={result} />}
            {rejection && <span className="min-w-0 truncate text-sky-600 dark:text-sky-400">{rejection}</span>}
          </>
        }
      >
        {!inline.has(p.kind) && body}
      </WithRaw>
    </div>
  );
};

const locate = /^(\S*[./]\S*?):(\d+)(?::\d+)?(?:[:\s-]+(.*))?$/;

/** Findings as file:line items when every line is one, else undefined. */
const locations = (findings: string) => {
  const lines = findings.split('\n').filter(line => line.trim());
  const items = lines.map(line => locate.exec(line.trim().replace(/^[-*]\s+/, '')));
  if (!items.length || items.some(item => !item)) return;
  return items.map(item => ({ file: item![1]!, line: item![2]!, message: item![3] ?? '' }));
};

/** Findings without the check's own name in front; nothing when a pass says no more than ok. */
const findingsOf = (verdict: Verdict) => {
  let text = verdict.findings?.trim() ?? '';
  if (text.startsWith(`${verdict.check}:`)) text = text.slice(verdict.check.length + 1).trim();
  return !text || (verdict.pass && /^(ok|pass(ed)?)\.?$/i.test(text)) ? undefined : text;
};

/**
 * Findings that read as one plain line: no line breaks, no file:line items and, when a check bot wrote them, no
 * markdown. Those sit on the check's own row; anything richer gets a block under it.
 */
const findingsLine = (verdict: Verdict) => {
  const findings = findingsOf(verdict);
  if (!findings || findings.includes('\n') || locations(findings)) return;
  if (verdict.runs?.length && /[`*_[\]#|>]/.test(findings)) return;
  return findings;
};

/** One-line findings as the end of a row, after a dash, truncated with the whole line as the tip. */
export const FindingsLine = ({ verdict }: { verdict: Verdict }) => {
  const line = findingsLine(verdict);
  if (!line) return null;
  return (
    <Tooltip tip={line} className="min-w-0">
      <span className="min-w-0 truncate text-zinc-500">
        <span className="mr-1.5 text-zinc-300 dark:text-zinc-600">—</span>
        {line}
      </span>
    </Tooltip>
  );
};

/**
 * A check's findings, without its name or status, which the row above already shows; nothing when they fit on that
 * row. Findings a check bot wrote are markdown; any other check's are its raw output, shown as is.
 */
export const VerdictView = ({ verdict }: { verdict: Verdict }) => {
  const findings = findingsOf(verdict);
  if (!findings || findingsLine(verdict)) return null;
  const found = locations(findings);
  return found ? (
    <ul className="min-w-0 space-y-0.5 font-mono text-[11px]">
      {found.map(({ file, line, message }, i) => (
        <li key={i} className="flex gap-2">
          <span className="shrink-0 text-zinc-700 dark:text-zinc-300">
            {file}:{line}
          </span>
          <span className="min-w-0 font-sans text-zinc-700 dark:text-zinc-300">{message}</span>
        </li>
      ))}
    </ul>
  ) : (
    <div className="min-w-0 text-xs">
      {verdict.runs?.length ? <Text text={findings} /> : <Code code={findings} compact wrap lines={12} />}
    </div>
  );
};

/** The result each proposal led to, matched in order within its kind, and the results no proposal accounts for. */
const pairResults = (proposals: unknown[], results: ApplyResult[]) => {
  const left = [...results];
  const paired = proposals.map(proposal => {
    const kind = (proposal as { kind?: unknown } | null)?.kind;
    const i = left.findIndex(r => r.kind === kind);
    return i < 0 ? undefined : left.splice(i, 1)[0];
  });
  return { paired, left };
};

/** What a run proposed and what became of each proposal. Checks show on their own rows. */
export const OutcomeView = ({ outcome }: { outcome: Outcome }) => {
  const { paired, left } = pairResults(outcome.proposals, outcome.results);
  if (!outcome.proposals.length && !outcome.errors.length && !left.length)
    return <p className="text-xs text-zinc-500">Nothing proposed.</p>;
  return (
    <div className="space-y-3">
      {outcome.proposals.map((proposal, i) => (
        <ProposalView
          key={i}
          proposal={proposal}
          result={paired[i]}
          rejection={
            outcome.rejected.find(
              r => r.proposal === proposal || JSON.stringify(r.proposal) === JSON.stringify(proposal)
            )?.reason
          }
        />
      ))}
      {outcome.errors.map((error, i) => (
        <p key={i} className="text-xs text-sky-600 dark:text-sky-400">
          {error}
        </p>
      ))}
      {left.map((result, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs">
          <span className="font-mono text-[11px] text-zinc-500">{result.kind}</span>
          <ResultView result={result} />
        </div>
      ))}
    </div>
  );
};

const time = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : undefined);

/** The fields of a stored run as a table: what ran, for which event, when, and where it sits. */
export const RunFields = ({ run }: { run: Run }) => (
  <Fields>
    <Field name="status">
      <Badge on={isFailed(run.status)}>{run.status}</Badge>
      {run.closure && (
        <>
          {' '}
          <Badge on={waits(run.closure)}>{run.closure}</Badge>
        </>
      )}
    </Field>
    <Field name="job">
      {run.workflow} / {run.job}
      {run.check && <span className="text-zinc-500"> check {run.check}</span>}
      {run.attempt !== undefined && <span className="text-zinc-500"> attempt {run.attempt}</span>}
    </Field>
    <Field name="bot">
      {run.bot ?? '-'}
      {run.harness && <span className="text-zinc-500"> {run.harness}</span>}
      {run.model && <span className="text-zinc-500"> {run.model}</span>}
    </Field>
    <Field name="event">
      {run.event.trigger}
      {run.event.action && `.${run.event.action}`} {run.event.repo}
      {run.event.number !== undefined && `#${run.event.number}`} {run.event.actor.login}
    </Field>
    {run.startedAt && (
      <Field name="time">
        {time(run.startedAt)}
        {run.endedAt && <span className="text-zinc-500"> to {time(run.endedAt)}</span>}
      </Field>
    )}
    {run.approval !== undefined && <Field name="approval">#{run.approval}</Field>}
    {run.parked && (
      <Field name="parked">
        <Branch name={run.parked} />
      </Field>
    )}
    {(run.error || run.reason) && (
      <Field name={run.error ? 'error' : 'reason'}>
        <span className={cx(run.error && 'text-sky-600 dark:text-sky-400')}>{run.error ?? run.reason}</span>
      </Field>
    )}
    {run.parent && (
      <Field name="parent">
        <span className="font-mono text-[11px]">{run.parent}</span>
      </Field>
    )}
    <Field name="id">
      <span className="font-mono text-[11px]">{run.id}</span>
    </Field>
  </Fields>
);
