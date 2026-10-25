import type { Split, Step, tunesOf } from '../../../bin/tune.ts';
import { getMean, sum } from '../../../src/stats.ts';

export type { Split, Step };
/** One tune as `/api/compound` answers it; `name` is its folder. */
export type TuneRows = ReturnType<typeof tunesOf>[number];


/**
 * The case-weighted quality of a step's evals on `splits`; select (fit and validate) by default.
 * @internal
 */
export const score = (step: Step, splits: Split[] = ['fit', 'validate']) => {
  const evals = step.evals.filter(e => splits.includes(e.split));
  const n = sum(evals.map(e => e.cases.length));
  return n ? sum(evals.map(e => e.quality * e.cases.length)) / n : undefined;
};

/**
 * A step's usd and minutes per run, case-weighted over its select evals. An eval without `perRun` counts its total
 * spread over its cases.
 */
const perRun = (step: Step) => {
  const evals = step.evals.filter(e => e.split !== 'test');
  const n = sum(evals.map(e => e.cases.length));
  const of = (k: 'usd' | 'minutes') =>
    n ? sum(evals.map(e => (e.perRun?.[k] ?? e[k] / Math.max(1, e.cases.length)) * e.cases.length)) / n : undefined;
  return { usd: of('usd'), minutes: of('minutes') };
};

/** The incumbent's value as a staircase: one corner per kept point that has one, running on to the last `x`. */
export const incumbent = (points: { x: number; y?: number | undefined; kept: boolean }[]) => {
  const corners = points.flatMap(p => (p.kept && p.y !== undefined ? [{ x: p.x, y: p.y }] : []));
  const end = Math.max(...points.map(p => p.x));
  return corners.length && end > corners.at(-1)!.x ? [...corners, { x: end, y: corners.at(-1)!.y }] : corners;
};

export type Point = ReturnType<typeof seriesOf>[number]['points'][number];

/** One series per tune, steps in order, each with its select score, usage and cumulative usd. */
export const seriesOf = (tunes: TuneRows[]) =>
  tunes
    .map(({ name, tune, steps }) => {
      let cum = 0;
      const start = Math.min(...steps.map(s => Date.parse(s.at)).filter(Number.isFinite));
      const points = steps
        .toSorted((a, b) => a.iteration - b.iteration || a.at.localeCompare(b.at))
        .map(step => {
          const usage = (k: 'usd' | 'minutes' | 'codex' | 'claude5h') => sum(step.evals.map(e => e[k]));
          cum += usage('usd');
          const at = Date.parse(step.at);
          return {
            step,
            y: score(step),
            hours: Number.isFinite(at) ? (at - start) / 3_600_000 : 0,
            run: perRun(step),
            usd: usage('usd'),
            minutes: usage('minutes'),
            codex: usage('codex'),
            claude: usage('claude5h'),
            cum,
          };
        });
      return {
        key: `${tune.repo}/${name}`,
        name,
        repo: tune.repo,
        skill: name.startsWith('skill@'),
        tune,
        points,
      };
    })
    .toSorted((a, b) => Number(a.skill) - Number(b.skill) || a.key.localeCompare(b.key));

export type Series = ReturnType<typeof seriesOf>[number];

/** Per iteration: the kept hub's score by its end, undefined before the first, and the usd spent by then. */
export const byIteration = (s: Series) => {
  const last = Math.max(0, ...s.points.map(p => p.step.iteration));
  let kept: number | undefined;
  return Array.from({ length: last + 1 }, (_, i) => {
    const at = s.points.filter(p => p.step.iteration === i);
    for (const p of at) if (p.step.verdict === 'kept' && p.y !== undefined) kept = p.y;
    const cum = at.at(-1)?.cum ?? s.points.filter(p => p.step.iteration < i).at(-1)?.cum ?? 0;
    return {
      iteration: i,
      kept,
      cum,
      usd: sum(at.map(p => p.usd)),
      minutes: sum(at.map(p => p.minutes)),
      codex: sum(at.map(p => p.codex)),
      claude: sum(at.map(p => p.claude)),
    };
  });
};

/**
 * Per tune name, per iteration: the mean over repos of the kept hub's score, the lowest and highest repo, and the mean
 * usage. A tune that stopped early holds its last kept hub; a repo with no kept score yet counts in none of them, and
 * an iteration where no repo has one has no `kept`.
 */
export const average = (series: Series[]) =>
  [...new Set(series.map(s => s.name))].map(name => {
    const group = series.filter(s => s.name === name);
    const rows = group.map(s => ({ repo: s.repo, rows: byIteration(s) }));
    const last = Math.max(...rows.map(r => r.rows.length));
    return {
      name,
      repos: rows.length,
      rows: Array.from({ length: last }, (_, i) => {
        const at = rows.map(r => ({ repo: r.repo, ...r.rows[Math.min(i, r.rows.length - 1)]! }));
        const ran = at.filter(a => a.iteration === i);
        const kept = at.flatMap(a => a.kept ?? []);
        return {
          iteration: i,
          ...(kept.length > 0 && { kept: getMean(kept), lo: Math.min(...kept), hi: Math.max(...kept) }),
          per: at.map(a => ({ repo: a.repo, kept: a.kept })),
          cum: getMean(at.map(a => a.cum)),
          usd: getMean(ran.map(a => a.usd)),
          minutes: getMean(ran.map(a => a.minutes)),
          codex: getMean(ran.map(a => a.codex)),
          claude: getMean(ran.map(a => a.claude)),
        };
      }),
    };
  });
