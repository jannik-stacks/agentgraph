import { Fragment } from 'react';
import { cx, Link, Tooltip } from '../ui.tsx';
import {
  type CheckField,
  formatResultValue,
  readFieldValue,
  type RunResult,
  type RunResults,
  splitRunsByAxis,
  getFieldSummary,
} from './result.ts';

const amber = 'text-amber-600 dark:text-amber-400';

const Strip = ({ runs, field }: { runs: RunResults[]; field: CheckField }) => {
  const s = getFieldSummary(runs, field);
  const bound = field.limit?.maximum ?? field.limit?.minimum;
  const lo = Math.min(s.low, bound ?? s.low);
  const hi = Math.max(s.high, bound ?? s.high);
  const x = (v: number) => (hi === lo ? 50 : 4 + ((v - lo) / (hi - lo)) * 92);
  return (
    <Tooltip
      tip={`${formatResultValue(field, s.low)} to ${formatResultValue(field, s.high)}; each dot is one run, the tick the median`}
    >
      <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden className="h-2.5 w-28 text-zinc-400">
        <line
          x1="4"
          x2="96"
          y1="5"
          y2="5"
          stroke="currentColor"
          strokeOpacity="0.3"
          vectorEffect="non-scaling-stroke"
        />
        {s.points.map(({ run, v }) => (
          <circle
            key={run.key}
            cx={x(v)}
            cy="5"
            r="2"
            fill="currentColor"
            fillOpacity="0.6"
            className={cx(s.outside.includes(run) && amber)}
          />
        ))}
        {bound !== undefined && (
          <line
            x1={x(bound)}
            x2={x(bound)}
            y1="2"
            y2="8"
            stroke="currentColor"
            className={amber}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {s.median !== undefined && (
          <line
            x1={x(s.median)}
            x2={x(s.median)}
            y1="0"
            y2="10"
            className="text-zinc-700 dark:text-zinc-300"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </Tooltip>
  );
};

const Trend = ({ steps, field }: { steps: number[]; field: CheckField }) => {
  if (steps.length < 2) return null;
  const lo = Math.min(...steps);
  const hi = Math.max(...steps);
  const y = (v: number) => (hi === lo ? 5 : 9 - ((v - lo) / (hi - lo)) * 8);
  const change = steps.at(-1)! - steps[0]!;
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg viewBox="0 0 60 10" aria-hidden className="h-2.5 w-[60px] text-zinc-500">
        <polyline
          points={steps.map((v, i) => `${(i / (steps.length - 1)) * 60},${y(v)}`).join(' ')}
          fill="none"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span>
        {change > 0 ? '+' : change < 0 ? '-' : ''}
        {formatResultValue(field, Math.abs(change))}
      </span>
    </span>
  );
};

const Cells = ({
  runs,
  field,
  trend,
  first,
}: {
  runs: RunResults[];
  field: CheckField;
  trend: string;
  first: boolean;
}) => {
  const s = getFieldSummary(runs, field, trend);
  const dead = runs.filter(r => r.dead);
  const failed = first && field.mode === 'warn' && s.warned > 0;
  return (
    <>
      <td className="pr-4">
        {s.values.length}
        {dead.length > 0 && (
          <Tooltip tip={dead.map(r => `${r.key}: ${r.dead}`).join('\n')}>
            <span className="text-zinc-400"> +{dead.length} dead</span>
          </Tooltip>
        )}
      </td>
      <td className={cx('pr-4', amber)}>
        {failed ? `${s.warned} of ${runs.length - dead.length}` : ''}
        {failed && s.outside.length > 0 && ', '}
        {s.outside.length > 0 && `${s.outside.length} over`}
      </td>
      <td className="pr-4">{formatResultValue(field, s.median)}</td>
      <td className="pr-4">{s.values.length > 0 && <Strip runs={runs} field={field} />}</td>
      <td className="pr-4">
        <Trend steps={s.trend} field={field} />
      </td>
    </>
  );
};

export const ResultTable = ({
  runs,
  fields,
  by,
  trend = 'time',
  onPick,
}: {
  runs: RunResults[];
  fields: CheckField[];
  by?: string | undefined;
  trend?: string;
  onPick?: (field: CheckField) => void;
}) => {
  const groups = by ? [...splitRunsByAxis(runs, by)] : [];
  const shown = fields.filter(f => runs.some(r => typeof readFieldValue(r, f) === 'number'));
  if (!shown.length) return null;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="text-left text-xs whitespace-nowrap tabular-nums">
        <thead className="text-zinc-500">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            {['check', 'field', 'runs', 'failed', 'median', 'spread', `trend over ${trend}`].map(h => (
              <th key={h} className="py-1 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-zinc-700 dark:text-zinc-300">
          {shown.map((field, i) => {
            const first = shown[i - 1]?.check !== field.check;
            return (
              <Fragment key={`${field.check} ${field.field}`}>
                <tr className={cx(first && 'border-t border-zinc-100 dark:border-zinc-900')}>
                  <td className="py-0.5 pr-4 font-mono">{first ? field.check : ''}</td>
                  <td className="pr-4 font-mono">
                    <Tooltip
                      tip={
                        [field.description, field.mode && `${field.mode} check`].filter(Boolean).join(', ') ||
                        field.field
                      }
                    >
                      {onPick ? (
                        <button
                          type="button"
                          className="underline decoration-zinc-300 underline-offset-2"
                          onClick={() => onPick(field)}
                        >
                          {field.field}
                        </button>
                      ) : (
                        <span>{field.field}</span>
                      )}
                    </Tooltip>
                  </td>
                  <Cells runs={runs} field={field} trend={trend} first={first} />
                </tr>
                {groups.map(([group, members]) => (
                  <tr key={group} className="text-zinc-500">
                    <td />
                    <td className="max-w-[24ch] truncate pr-4 pl-3 font-mono">{group}</td>
                    <Cells runs={members} field={field} trend={trend} first={first} />
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export const ResultsLink = ({ query, children }: { query: string; children: string }) => (
  <Link href={query ? `/results?${query}` : '/results'} className="underline underline-offset-2">
    {children}
  </Link>
);

const when = (r: RunResult) => (r.later ? `checked later ${r.at.slice(0, 10)}` : 'at run end');

export const RunResultLines = ({ run, fields }: { run: RunResults; fields: CheckField[] }) => {
  const checks = Object.entries(run.results);
  if (!checks.length) return null;
  const failed = checks.filter(([check, r]) => !r.pass && fields.some(f => f.check === check && f.mode !== 'info'));
  const past = (f: CheckField) => {
    const v = readFieldValue(run, f);
    if (typeof v !== 'number' || !f.limit) return;
    if (f.limit.maximum !== undefined && v > f.limit.maximum)
      return `${f.field} ${formatResultValue(f, v)} over ${formatResultValue(f, f.limit.maximum)}`;
    if (f.limit.minimum !== undefined && v < f.limit.minimum)
      return `${f.field} ${formatResultValue(f, v)} under ${formatResultValue(f, f.limit.minimum)}`;
  };
  const values = fields.flatMap(f => {
    const v = readFieldValue(run, f);
    return v === undefined ? [] : [`${f.check} ${f.field} ${formatResultValue(f, v)}`];
  });
  const times = [...new Set(checks.map(([, r]) => when(r)))];
  return (
    <div className="space-y-0.5 py-0.5 text-zinc-600 dark:text-zinc-400">
      <p>
        <span className="text-zinc-500">gates </span>
        {failed.length === 0
          ? 'all passed'
          : failed.map(([check], i) => {
              const why = fields.filter(f => f.check === check).flatMap(f => past(f) ?? []);
              const mode = fields.find(f => f.check === check)?.mode;
              return (
                <span key={check} className={amber}>
                  {i > 0 && ', '}
                  {check} {mode === 'block' ? 'blocked' : 'warned'}
                  {why.length > 0 && ` (${why.join(', ')})`}
                </span>
              );
            })}
      </p>
      <p className="min-w-0 overflow-x-auto whitespace-nowrap">
        <span className="text-zinc-500">results </span>
        {values.join(', ') || 'no values'}
        <span className="text-zinc-500">, {times.join(' and ')} </span>
        <ResultsLink query={`run=${encodeURIComponent(run.key)}`}>all results &gt;</ResultsLink>
      </p>
    </div>
  );
};
