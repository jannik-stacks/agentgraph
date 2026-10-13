import type { ComponentType, ReactNode } from 'react';
import type { ApplyResult } from '../../../../src/apply.ts';
import { Proposal } from '../../../../src/outputs.ts';
import type { Outcome, Run, Verdict } from '../../../../src/store.ts';
import type { Tone } from '../../graph-model.ts';
import { Code } from '../../Markdown.tsx';
import { Icon, KindIcon } from '../../studio/icons.tsx';
import { Badge, Chip, Chips, closureTones, cx, Field, Fields, statusTone, Tooltip } from '../../ui.tsx';
import { JsonView, Label, Text, WithRaw } from './core.tsx';

type Of<K extends Proposal['kind']> = { proposal: Extract<Proposal, { kind: K }> };

const Branch = ({ name }: { name: string }) => (
  <code className="rounded bg-zinc-100 px-1 font-mono text-[11px] dark:bg-zinc-800">{name}</code>
);

const Files = ({ files }: { files: { path: string; gone?: boolean }[] }) => (
  <ul className="font-mono text-[11px]">
    {files.map(({ path, gone }) => (
      <li key={path} className={cx(gone && 'text-red-600 line-through dark:text-red-400')}>
        {path}
      </li>
    ))}
  </ul>
);

const Title = ({ children }: { children: string }) => <div className="font-medium">{children}</div>;

const views: { [K in Proposal['kind']]: ComponentType<Of<K>> } = {
  reply: ({ proposal }) => <Text text={proposal.body} />,
  label: ({ proposal }) => (
    <Chips>
      {proposal.add?.map(label => (
        <Chip key={`+${label}`} dot="bg-emerald-500" title="Label to add">
          + {label}
        </Chip>
      ))}
      {proposal.remove?.map(label => (
        <Chip key={`-${label}`} dot="bg-red-500" title="Label to remove">
          - {label}
        </Chip>
      ))}
    </Chips>
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
        <KindIcon kind="note" />
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
      <Icon name="question" className="mt-0.5 size-3.5 text-amber-600" />
      <Text text={proposal.question} />
    </div>
  ),
  close: ({ proposal }) => (
    <div className="flex items-start gap-1.5">
      <Badge tone={closureTones[proposal.as]}>{proposal.as}</Badge>
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

/** A proposal drawn for its kind, with its rejection reason when it was rejected. */
export const ProposalView = ({ proposal, rejection }: { proposal: unknown; rejection?: string | undefined }) => {
  const parsed = Proposal.safeParse(proposal);
  if (!parsed.success)
    return (
      <div className="space-y-1">
        {rejection && <p className="text-xs text-red-600 dark:text-red-400">{rejection}</p>}
        <JsonView value={proposal} label="proposal" />
      </div>
    );
  const p = parsed.data;
  const View = views[p.kind] as ComponentType<{ proposal: Proposal }>;
  const icon = kindIcon[p.kind];
  return (
    <WithRaw value={proposal}>
      <div
        className={cx(
          'min-w-0 space-y-1 text-xs',
          rejection && 'rounded border-l-2 border-red-400 pl-2 opacity-80 dark:border-red-700'
        )}
      >
        <div className="flex items-center gap-1.5 text-zinc-500">
          {icon && <Icon name={icon} className="size-3" />}
          <span className="font-mono text-[11px]">{p.kind}</span>
        </div>
        {rejection && <p className="text-red-600 dark:text-red-400">{rejection}</p>}
        <View proposal={p} />
      </div>
    </WithRaw>
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

const verdictLook = (v: Pick<Verdict, 'pass' | 'gating' | 'skipped'>) =>
  v.skipped
    ? { icon: 'skipped' as const, tint: 'text-zinc-400' }
    : v.pass
      ? { icon: 'ok' as const, tint: 'text-emerald-600 dark:text-emerald-400' }
      : { icon: 'fail' as const, tint: v.gating ? 'text-red-600 dark:text-red-400' : 'text-amber-600' };

/**
 * A check's verdict: pass, fail or skipped, and its findings. Findings a check bot wrote are markdown; any other
 * check's are its raw output, shown as is.
 */
export const VerdictView = ({ verdict }: { verdict: Verdict }) => {
  const look = verdictLook(verdict);
  const found = verdict.findings ? locations(verdict.findings) : undefined;
  return (
    <div className="min-w-0 space-y-1 text-xs">
      <div className="flex items-center gap-1.5">
        <Tooltip tip={verdict.skipped ? 'Check skipped' : verdict.pass ? 'Check passed' : 'Check failed'}>
          <Icon name={look.icon} className={cx('size-3.5', look.tint)} />
        </Tooltip>
        <span className="font-mono">{verdict.check}</span>
        {!verdict.gating && <Label>log</Label>}
      </div>
      {found ? (
        <ul className="space-y-0.5 pl-5 font-mono text-[11px]">
          {found.map(({ file, line, message }, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 text-sky-700 dark:text-sky-400">
                {file}:{line}
              </span>
              <span className="min-w-0 font-sans text-zinc-700 dark:text-zinc-300">{message}</span>
            </li>
          ))}
        </ul>
      ) : (
        verdict.findings && (
          <div className="pl-5">
            {verdict.runs?.length ? <Text text={verdict.findings} /> : <Code code={verdict.findings} />}
          </div>
        )
      )}
    </div>
  );
};

const resultTone: Record<ApplyResult['status'], Tone> = {
  applied: 'ok',
  pending: 'warn',
  skipped: 'neutral',
  failed: 'danger',
};

const Group = ({
  icon,
  count,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  count: number;
  children: ReactNode;
}) =>
  count ? (
    <section className="space-y-2">
      <div className="flex items-center gap-1 text-[11px] text-zinc-500">
        <Icon name={icon} className="size-3" />
        {count}
      </div>
      {children}
    </section>
  ) : null;

/** What a run proposed, how its checks went and what landed. */
export const OutcomeView = ({ outcome }: { outcome: Outcome }) => (
  <div className="space-y-4">
    <Group icon="file" count={outcome.proposals.length + outcome.errors.length}>
      {outcome.proposals.map((proposal, i) => (
        <ProposalView
          key={i}
          proposal={proposal}
          rejection={
            outcome.rejected.find(
              r => r.proposal === proposal || JSON.stringify(r.proposal) === JSON.stringify(proposal)
            )?.reason
          }
        />
      ))}
      {outcome.errors.map((error, i) => (
        <p key={i} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ))}
    </Group>
    <Group icon="ok" count={outcome.checks?.length ?? 0}>
      {outcome.checks?.map(verdict => (
        <VerdictView key={verdict.check} verdict={verdict} />
      ))}
    </Group>
    <Group icon="open" count={outcome.results.length}>
      <ul className="space-y-1 text-xs">
        {outcome.results.map((result, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <Badge tone={resultTone[result.status]}>{result.status}</Badge>
            <span className="font-mono">{result.kind}</span>
            {result.url && (
              <a
                className="truncate text-sky-600 underline dark:text-sky-400"
                href={result.url}
                target="_blank"
                rel="noreferrer"
              >
                {result.url}
              </a>
            )}
            {result.reason && <span className="text-zinc-500">{result.reason}</span>}
          </li>
        ))}
      </ul>
    </Group>
  </div>
);

/** The fields of a stored run. */
export const RunFields = ({ run }: { run: Run }) => (
  <WithRaw value={run}>
    <Fields>
      <Field name="status">
        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
        {run.closure && (
          <>
            {' '}
            <Badge tone={closureTones[run.closure]}>{run.closure}</Badge>
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
      {run.approval !== undefined && <Field name="approval">#{run.approval}</Field>}
      {run.error && (
        <Field name="error">
          <span className="text-red-600 dark:text-red-400">{run.error}</span>
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
  </WithRaw>
);
