import { useAtomValue } from 'jotai';
import type { Trace } from '../../../src/store.ts';
import type { Run, Step, Workflow } from '../../../src/workflow.ts';
import { Markdown } from '../Markdown.tsx';
import { lineRow, Rows, runRow } from '../runs/rows.tsx';
import { runsAtom } from '../state.ts';
import { Field, Fields } from '../ui.tsx';
import type { Fixture, Trail } from './scenarios.ts';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-1">
    <h3 className="font-medium text-zinc-500">{title}</h3>
    {children}
  </section>
);

const doing = (does: Step['does']) =>
  'agent' in does
    ? `the ${does.agent} agent${does.skill ? ` with the ${does.skill} skill` : ''}`
    : 'run' in does
      ? 'a script'
      : 'you';

/** A simulated trail as the outcome lines a real run would have traced. */
const traceOf = (trail: Trail, run: Run): Trace[] =>
  trail.map(({ at, outcome }, i) => {
    const { step, status, tries, rounds } = trail[i + 1]?.at ?? run;
    return { at: '', step: at.step, outcome, run: { step, status, tries, rounds } };
  });

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

/** The served hub's runs that stand at a step now. */
const RunsHere = ({ fixture, step }: { fixture: string; step: string }) => {
  const { value: runs = [] } = useAtomValue(runsAtom);
  const here = runs.filter(
    r => r.fixture === fixture && r.run.step === step && ['running', 'waiting'].includes(r.run.status)
  );
  if (!here.length) return <p className="text-zinc-500">No run stands here.</p>;
  return <Rows rows={here.slice(0, 8).map(r => runRow(r))} />;
};

/** A step's doer, checks, tries and way back in plain words, what the picked run did there, and its prompts. */
export const StepDetails = ({
  fixture,
  step,
  run,
}: {
  fixture: Fixture;
  step: Step;
  run?: { run: Run; trail: Trail; trace?: Trace[] | undefined } | undefined;
}) => {
  const { workflow, checks } = fixture;
  const { does } = step;
  const lines = run && (run.trace ?? traceOf(run.trail, run.run)).filter(line => line.step === step.name);
  return (
    <div className="space-y-4 p-4 text-xs">
      <div>
        <h2 className="text-sm font-semibold">{step.name}</h2>
        <p className="text-zinc-500">in {workflow.name}</p>
      </div>
      <Fields>
        <Field name="done by">{doing(does)}</Field>
        {!('wait' in does) && <Field name="tries">{step.tries}, then it asks you</Field>}
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
                  <span className="text-zinc-500">{check?.agent === undefined ? 'script' : 'agent'}</span>
                  <span className={check?.mode === 'stop' ? 'text-rose-600' : 'text-zinc-500'}>
                    {check?.mode ?? 'block'}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {lines && (
        <Section title="In the picked run">
          {lines.length ? (
            <Rows rows={lines.map(lineRow)} />
          ) : (
            <p className="text-zinc-500">The run has not been here.</p>
          )}
        </Section>
      )}
      {fixture.agents && (
        <Section title="Runs here now">
          <RunsHere fixture={fixture.id} step={step.name} />
        </Section>
      )}
      {'run' in does && (
        <Section title="Command">
          <Markdown text={`\`\`\`sh\n${does.run}\n\`\`\``} />
        </Section>
      )}
      {'agent' in does && does.skill && fixture.skills?.[does.skill] && (
        <Section title="Skill">
          <Markdown text={fixture.skills[does.skill]!} />
        </Section>
      )}
      {'agent' in does && fixture.agents?.[does.agent] && (
        <Section title="Agent">
          <Markdown text={fixture.agents[does.agent]!} />
        </Section>
      )}
    </div>
  );
};
