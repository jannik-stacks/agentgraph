import { useAtomValue } from 'jotai';
import type { Trace } from '../../../core/src/store.ts';
import type { Outcome, Step, Workflow } from '../../../core/src/workflow.ts';
import { skillOf, type Config } from '../../../src/config.ts';
import { Markdown } from '../Markdown.tsx';
import { age, PhaseWord } from '../runs/bits.tsx';
import { live } from '../runs/live.ts';
import { phaseOf } from '../runs/model.ts';
import { detail, say } from '../runs/trace.ts';
import { Field, Fields, Link } from '../ui.tsx';
import type { Fixture, Trail } from './scenarios.ts';

const said = (o: Outcome) => [o.kind, detail(o)].filter(Boolean).join(': ');

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-1">
    <h3 className="font-medium text-zinc-500">{title}</h3>
    {children}
  </section>
);

const doing = (does: Step['does']) =>
  'bot' in does
    ? `the ${does.bot} bot${does.skill ? ` with the ${does.skill} skill` : ''}`
    : 'run' in does
      ? 'a script'
      : 'you';

/** A workflow's trigger and description. */
export const WorkflowDetails = ({ workflow }: { workflow: Workflow }) => (
  <div className="space-y-4 p-4 text-xs">
    <h2 className="text-sm font-semibold">{workflow.name}</h2>
    <Fields>
      <Field name="steps">{workflow.steps.map(s => s.name).join(', ')}</Field>
      {workflow.branch && <Field name="branch">{workflow.branch}</Field>}
      {workflow.base && <Field name="base">{workflow.base}</Field>}
    </Fields>
    {workflow.body && <Markdown text={workflow.body} />}
  </div>
);

/** What one run did at a step: its trace lines when it is real, its outcomes when it is simulated. */
const RunAtStep = ({ step, trail, trace }: { step: string; trail: Trail; trace?: Trace[] | undefined }) => {
  const lines = trace
    ? trace.filter(line => line.step === step).map(line => ({ at: line.at.slice(11, 19), text: say(line), line }))
    : trail.filter(t => t.at.step === step).map(t => ({ at: '', text: said(t.outcome), line: undefined }));
  if (!lines.length) return <p className="text-zinc-500">The run has not been here.</p>;
  return (
    <ol className="space-y-0.5 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
      {lines.map(({ at, text, line }, i) => (
        <li key={i} className="break-words">
          {at && `${at} `}
          {text}
          {line && 'applied' in line && line.applied.url && (
            <a className="ml-1 text-sky-600 underline" href={line.applied.url} target="_blank" rel="noreferrer">
              {line.applied.url.replace('https://github.com/', '')}
            </a>
          )}
        </li>
      ))}
    </ol>
  );
};

/** The latest v1 runs of a step from the live run list. */
const LatestRuns = ({ workflow, step }: { workflow: string; step: string }) => {
  const rows = useAtomValue(live.rows);
  const runs = (rows ?? []).filter(r => r.workflow === workflow && r.job === step && !r.check).slice(0, 8);
  if (!runs.length) return <p className="text-zinc-500">No runs yet.</p>;
  return (
    <ul className="space-y-0.5">
      {runs.map(run => (
        <li key={run.id}>
          <Link href={`/runs/${encodeURIComponent(run.id)}`} className="flex items-center gap-2 hover:underline">
            <span className="min-w-0 flex-1 truncate">
              {run.event.number !== undefined ? `#${run.event.number}` : run.event.trigger}
              {(run.attempt ?? 1) > 1 && `, try ${run.attempt}`}
            </span>
            <PhaseWord phase={phaseOf(run)} status={run.status} />
            <span className="w-14 shrink-0 text-right text-zinc-500">{age(run.startedAt ?? run.event.ts)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
};

/** A step's doer, checks, tries and way back in plain words, what the picked run did there, and its prose. */
export const StepDetails = ({
  fixture,
  step,
  run,
  config,
}: {
  fixture: Fixture;
  step: Step;
  run?: { trail: Trail; trace?: Trace[] | undefined } | undefined;
  config?: Config | undefined;
}) => {
  const { workflow, checks } = fixture;
  const spec = config?.workflows[workflow.name]?.steps[step.name];
  const about = spec?.bot ? config?.skills[skillOf(step.name, spec)]?.body : spec?.run;
  return (
    <div className="space-y-4 p-4 text-xs">
      <div>
        <h2 className="text-sm font-semibold">{step.name}</h2>
        <p className="text-zinc-500">in {workflow.name}</p>
      </div>
      <Fields>
        <Field name="done by">{doing(step.does)}</Field>
        {!('wait' in step.does) && <Field name="tries">{step.tries}, then it asks you</Field>}
        {step.each && <Field name="each">{typeof step.each === 'string' ? step.each : step.each.run}</Field>}
        {step.back && (
          <Field name="back">
            to {step.back.to}
            {step.back.until && ` until ${step.back.until}`}
            {step.back.rounds !== undefined
              ? `, at most ${step.back.rounds} ${step.back.rounds === 1 ? 'time' : 'times'}`
              : ', when you request changes'}
          </Field>
        )}
      </Fields>
      {step.checks.length > 0 && (
        <Section title="Checks after each try">
          <ul className="space-y-0.5">
            {step.checks.map(name => {
              const check = checks[name];
              return (
                <li key={name} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
                  <span className="text-zinc-500">{check?.judge === undefined ? 'script' : 'bot'}</span>
                  <span className={check?.mode === 'stop' ? 'text-rose-600' : 'text-zinc-500'}>
                    {check?.mode ?? 'block'}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {run && (
        <Section title="In the picked run">
          <RunAtStep step={step.name} trail={run.trail} trace={run.trace} />
        </Section>
      )}
      {config && (
        <Section title="Latest runs">
          <LatestRuns workflow={workflow.name} step={step.name} />
        </Section>
      )}
      {about && (
        <Section title={spec?.bot ? 'Skill' : 'Command'}>
          <Markdown text={spec?.bot ? about : `\`\`\`sh\n${about}\n\`\`\``} />
        </Section>
      )}
    </div>
  );
};
