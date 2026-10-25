import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { makeWorkflowGraph } from '../../../src/graph.ts';
import type { Trace } from '../../../src/trace.ts';
import type { CheckResult, Run, Step, Workflow } from '../../../src/workflow.ts';
import { Code, Markdown } from '../Markdown.tsx';
import { lineRow, Rows, RunLine } from '../runs/rows.tsx';
import { runsAtom } from '../state.ts';
import { accent, cx, Disclosure, Field, Fields, Tooltip } from '../ui.tsx';
import type { Fixture, RunDrawnOnWorkflow, Trail } from './scenarios.ts';

const Section = ({ title, tip, children }: { title: string; tip?: string; children: React.ReactNode }) => (
  <section className="space-y-1.5">
    <h3 className="font-medium text-zinc-500">{tip ? <Term tip={tip}>{title}</Term> : title}</h3>
    {children}
  </section>
);

const Prompt = ({ title, text }: { title: string; text: string }) => (
  <Section title={title}>
    <Markdown text={text} />
  </Section>
);

/** A word with a dotted underline that explains itself on hover. */
const Term = ({ tip, children }: { tip: string; children: React.ReactNode }) => (
  <Tooltip tip={tip}>
    <span className="cursor-help underline decoration-zinc-200 decoration-dotted underline-offset-3 hover:decoration-zinc-400 dark:decoration-zinc-700">
      {children}
    </span>
  </Tooltip>
);

const gates = {
  warn: 'A failure is recorded and never holds the step.',
  block: 'A failure fails the try, and the output goes back as feedback.',
  stop: 'A failure stops the run.',
};

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

/** The latest result of a check among a run's lines at one step. */
const latest = (name: string, lines: Trace[]): CheckResult | undefined => {
  for (const line of lines.toReversed()) {
    if ('check' in line && line.check.check === name) return line.check;
    if ('outcome' in line && line.outcome.kind === 'failed') {
      const found = line.outcome.checks.find(c => c.check === name);
      if (found) return found;
    }
  }
};

/** A check as one list item: its name, who judges it and its gate, its script on demand, and with a run its latest result. */
const CheckItem = ({
  name,
  check,
  lines,
}: {
  name: string;
  check: Fixture['checks'][string] | undefined;
  lines: Trace[] | undefined;
}) => {
  const [script, setScript] = useState(false);
  const result = lines && latest(name, lines);
  const mode = check?.mode ?? 'block';
  const kind =
    check?.agent === undefined
      ? { label: 'script', tip: 'A script; exit 0 passes, and the output is the feedback.' }
      : {
          label: check.run ? `script, judged by ${check.agent}` : `judged by ${check.agent}`,
          tip: check.run
            ? `The script runs and its output goes to ${check.agent}, whose reply must start with PASS; FAIL is a finding.`
            : `${check.agent} judges the diff; a reply starting with PASS passes, with FAIL fails.`,
        };
  return (
    <li className="flex gap-2">
      <span aria-hidden className="text-zinc-400">
        –
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono">{name}</span>
          <span className="text-zinc-500">
            <Term tip={kind.tip}>{kind.label}</Term>, <Term tip={gates[mode]}>{mode}</Term>
          </span>
          {check?.run && (
            <button
              type="button"
              aria-pressed={script}
              onClick={() => setScript(!script)}
              className="ml-auto rounded px-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 aria-pressed:bg-zinc-100 aria-pressed:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:aria-pressed:bg-zinc-800 dark:aria-pressed:text-zinc-200"
            >
              script
            </button>
          )}
        </div>
        {script && check?.run && (
          <div className="agi-in">
            <Code code={check.run} lang="sh" compact wrap lines={12} />
          </div>
        )}
        {lines &&
          (result ? (
            <Disclosure
              summary={
                <span className={cx(!result.pass && accent.text)}>
                  {result.pass ? 'passed' : 'failed'} last, {result.ms} ms
                </span>
              }
            >
              {result.findings ? (
                <Code code={result.findings} compact wrap lines={12} />
              ) : (
                <p className="text-zinc-500">No findings.</p>
              )}
            </Disclosure>
          ) : (
            <p className="text-zinc-500">Not run yet in this run.</p>
          ))}
      </div>
    </li>
  );
};

const concurrency = {
  steer: 'A trusted comment reaches the working session, which gets one more turn with it before the checks.',
  queue: 'A trusted comment waits until the try ends, then applies as an answer would.',
  cancel: 'A trusted comment stops the session, and the step starts again at once with it as feedback.',
};

/** One sentence on what makes a trigger start a run. */
const startsOn = (event: string, t: { command?: string; label?: string; branches?: string[] }) =>
  t.command
    ? `A comment starting with ${t.command} starts a run.`
    : t.label
      ? `Adding the ${t.label} label to an issue starts a run.`
      : event === 'dispatch'
        ? 'A run proposal from another workflow starts a run.'
        : event === 'feedback'
          ? 'What a trusted person says or pushes where another run worked starts a retro.'
          : t.branches
            ? `${event.replace('_', ' ')} on ${t.branches.join(', ')}: accepted, starts nothing yet.`
            : `Each ${event.replace('_', ' ')} event starts a run.`;

/** A workflow's trigger, branches and concurrency, each explained on hover, and its description. */
export const WorkflowDetails = ({ workflow }: { workflow: Workflow }) => (
  <div className="space-y-5 p-4 text-xs">
    <h2 className="text-sm font-semibold">{workflow.name}</h2>
    <Fields>
      <Field name={<Term tip="What starts a run of this workflow.">on</Term>}>
        {Object.entries(workflow.on).map(([event, t], i) => (
          <span key={event}>
            {i > 0 && ', '}
            <Term tip={startsOn(event, t ?? {})}>{event.replace('_', ' ')}</Term>
          </span>
        ))}
      </Field>
      <Field name={<Term tip="The steps, run in the order written.">steps</Term>}>
        {workflow.steps.map(s => s.name).join(', ')}
      </Field>
      {workflow.checks.length > 0 && (
        <Field name={<Term tip="Checks that run once when a run is done or stopped; they only warn.">checks</Term>}>
          {workflow.checks.join(', ')}
        </Field>
      )}
      {workflow.branch && (
        <Field name={<Term tip="The branch a run works on; {issue} and {parent} are filled in.">branch</Term>}>
          {workflow.branch}
        </Field>
      )}
      {workflow.base && (
        <Field name={<Term tip="The branch its pull requests go into.">base</Term>}>{workflow.base}</Field>
      )}
      <Field
        name={
          <Term tip="What a trusted comment does to a working run; it never starts a second run.">concurrency</Term>
        }
      >
        <Term tip={concurrency[workflow.concurrency]}>{workflow.concurrency}</Term>
      </Field>
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
  return (
    <ul>
      {here.slice(0, 8).map(r => (
        <li key={r.run.id}>
          <RunLine r={r} />
        </li>
      ))}
    </ul>
  );
};

/** A step's doer, checks, tries and way back in plain words, what the picked run did there, and its prompts. */
export const StepDetails = ({
  fixture,
  step,
  run,
}: {
  fixture: Fixture;
  step: Step;
  run?: RunDrawnOnWorkflow | undefined;
}) => {
  const { workflow, checks } = fixture;
  const { does } = step;
  const lines = run && (run.trace ?? traceOf(run.trail, run.run)).filter(line => line.step === step.name);
  const graph = makeWorkflowGraph(workflow, checks, undefined, fixture.roles);
  const { trigger } = graph;
  const { writes, model } = graph.nodes.find(n => n.step === step.name) ?? {};
  const waits = 'wait' in does;
  return (
    <div className="space-y-5 p-4 text-xs">
      <div>
        <h2 className="text-sm font-semibold">{step.name}</h2>
        <p className="text-zinc-500">
          in <Term tip={`A step of the ${workflow.name} workflow, which starts on ${trigger}.`}>{workflow.name}</Term>
        </p>
      </div>
      <Fields>
        <Field name="done by">
          <Term
            tip={
              'agent' in does
                ? 'An agent runs the step in a session.'
                : 'run' in does
                  ? 'A script runs the step.'
                  : 'The step waits for a person. An approving review, an approved label or a merge passes it.'
            }
          >
            {doing(does)}
          </Term>
        </Field>
        {'agent' in does && model !== undefined && (
          <Field name={<Term tip="The model alias the agent asks the proxy for.">model</Term>}>
            {model}, set by <span className="font-mono">model</span> in{' '}
            <span className="font-mono">agents/{does.agent}.md</span>
          </Field>
        )}
        {'agent' in does && writes && (
          <Field
            name={
              <Term tip="What this step's agent may write to GitHub; the engine refuses any other kind.">
                github writes
              </Term>
            }
          >
            {writes.length ? writes.join(', ') : 'none'}, set by <span className="font-mono">returns</span> in{' '}
            <span className="font-mono">agents/{does.agent}.md</span>
          </Field>
        )}
        {!waits && (
          <Field name={<Term tip="Tries before the run waits, the first one included.">tries</Term>}>
            {step.tries},{' '}
            <Term tip="When tries run out, the run waits for a human instead of going on.">then it asks you</Term>
          </Field>
        )}
        {step.each && (
          <Field name={<Term tip="One fresh session per item; past 20 items, one session over them all.">each</Term>}>
            {typeof step.each === 'string' ? step.each : step.each.run}
          </Field>
        )}
        {step.back && (
          <Field
            name={
              <Term
                tip={
                  waits
                    ? 'A request for changes sends the run back to this step.'
                    : 'Where the run goes back while the step is not satisfied, at most this many rounds; then it asks you.'
                }
              >
                back
              </Term>
            }
          >
            to {step.back.to}
            {step.back.until && ` until ${step.back.until}`}
            {step.back.rounds !== undefined
              ? `, at most ${step.back.rounds} ${step.back.rounds === 1 ? 'time' : 'times'}`
              : ', when you request changes'}
          </Field>
        )}
        {step.follow && (
          <Field
            name={
              <Term tip="How the branch follows a moved base, with no model; then the checks below run again.">
                base moves
              </Term>
            }
          >
            {step.follow === 'merge' ? 'merges the base in' : 'rebases onto the base'}, then runs the checks below
          </Field>
        )}
      </Fields>
      {step.checks.length > 0 && (
        <Section
          title="Checks"
          tip={
            waits
              ? 'What runs again when the base moves. If they fail, the run goes back as a request for changes would.'
              : 'What must pass before the step is done. They run after each try, all at once.'
          }
        >
          <ul className="space-y-1.5">
            {step.checks.map(name => (
              <CheckItem key={name} name={name} check={checks[name]} lines={lines} />
            ))}
          </ul>
        </Section>
      )}
      {lines && (
        <Section title="In the picked run">
          {lines.length ? (
            <Rows rows={lines.map(line => lineRow(line))} />
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
        <Prompt title={`Skill, ${does.skill}`} text={fixture.skills[does.skill]!} />
      )}
      {'agent' in does && fixture.agents?.[does.agent] && (
        <Prompt title={`Agent, ${does.agent}`} text={fixture.agents[does.agent]!} />
      )}
    </div>
  );
};
