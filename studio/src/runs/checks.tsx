import { getMean } from '../../../src/stats.ts';
import type { Trace } from '../../../src/trace.ts';
import { Disclosure, Tooltip } from '../ui.tsx';
import { findLatestCheckResults, formatCheckValue, formatNumber, getCheckNumbers } from './trace.ts';

type Numbers = ReturnType<typeof getCheckNumbers>;

const getMedian = (xs: number[]) => {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const Strip = ({ values, lo, hi }: { values: number[]; lo: number; hi: number }) => {
  const x = (v: number) => (hi === lo ? 50 : 4 + ((v - lo) / (hi - lo)) * 92);
  return (
    <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden className="h-2.5 w-28 text-zinc-400">
      <line x1="4" x2="96" y1="5" y2="5" stroke="currentColor" strokeOpacity="0.3" vectorEffect="non-scaling-stroke" />
      {values.map((v, i) => (
        <circle key={i} cx={x(v)} cy="5" r="2" fill="currentColor" fillOpacity="0.6" />
      ))}
      <line
        x1={x(getMedian(values))}
        x2={x(getMedian(values))}
        y1="0"
        y2="10"
        className="text-zinc-700 dark:text-zinc-300"
        stroke="currentColor"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

const groupByName = (sets: Numbers[]) => {
  const byName = new Map<string, number[]>();
  for (const { name, value } of sets.flat()) byName.set(name, [...(byName.get(name) ?? []), value]);
  return [...byName].toSorted(([a], [b]) => a.localeCompare(b));
};

export const CheckValues = ({ trace }: { trace: Trace[] }) => {
  const results = findLatestCheckResults(trace).filter(r => r.value || r.share !== undefined);
  if (!results.length) return null;
  return (
    <ul className="space-y-0.5 py-0.5 text-zinc-600 tabular-nums dark:text-zinc-400">
      {results.map(r => (
        <li key={r.check} className="flex gap-2">
          <span className="w-[14ch] shrink-0 truncate text-zinc-500">{r.check}</span>
          <span className="min-w-0 truncate">
            {r.empty ? 'empty' : formatCheckValue(r)}
            {!r.pass && <span className="text-zinc-500">, failed</span>}
          </span>
        </li>
      ))}
    </ul>
  );
};

export const CheckSpread = ({ traces }: { traces: Trace[][] }) => {
  const rows = groupByName(traces.map(t => getCheckNumbers(findLatestCheckResults(t))));
  if (!rows.length) return null;
  return (
    <Disclosure summary={`Check values across ${traces.length} runs`} className="text-xs text-zinc-500">
      <table className="mt-1 text-left whitespace-nowrap tabular-nums">
        <thead>
          <tr>
            {['check', 'runs', 'median', 'range', ''].map(h => (
              <th key={h} className="pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-zinc-700 dark:text-zinc-300">
          {rows.map(([name, values]) => {
            const lo = Math.min(...values);
            const hi = Math.max(...values);
            return (
              <tr key={name}>
                <td className="pr-4 font-mono">{name}</td>
                <td className="pr-4">{values.length}</td>
                <td className="pr-4">{formatNumber(getMedian(values))}</td>
                <td className="pr-4">
                  {formatNumber(lo)} to {formatNumber(hi)}
                </td>
                <td>
                  <Tooltip tip="Each dot is one run; the tick is the median.">
                    <Strip values={values} lo={lo} hi={hi} />
                  </Tooltip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Disclosure>
  );
};

export const CheckMeans = ({ groups }: { groups: { key: string; label: string; numbers: Numbers[] }[] }) => {
  const names = [...new Set(groups.flatMap(g => g.numbers.flat().map(n => n.name)))].sort();
  if (!names.length) return null;
  return (
    <Disclosure summary="Check values per point" className="text-xs text-zinc-500">
      <div className="mt-1 overflow-x-auto">
        <table className="text-left whitespace-nowrap tabular-nums">
          <thead>
            <tr>
              {['point', ...names].map(h => (
                <th key={h} className="pr-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-zinc-700 dark:text-zinc-300">
            {groups.map(g => {
              const byName = new Map(groupByName(g.numbers));
              return (
                <tr key={g.key}>
                  <td className="pr-4 font-mono">{g.label}</td>
                  {names.map(name => {
                    const values = byName.get(name);
                    return (
                      <td key={name} className="pr-4">
                        {values ? (
                          <Tooltip tip={`mean over ${values.length} runs`}>
                            <span>{formatNumber(getMean(values))}</span>
                          </Tooltip>
                        ) : (
                          ''
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Disclosure>
  );
};
