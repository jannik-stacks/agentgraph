export type Split = 'mine' | 'fit' | 'validate' | 'test';
type Tune = {
  repo: string;
  engine: string;
  point: string;
  cases: Record<string, Split>;
  preset: 'hidden' | 'composite';
  keep: { p: number; delta: number; screen: number };
};
type Eval = {
  candidate: string;
  split: Split;
  cases: string[];
  quality: number;
  ci: [number, number];
  delta?: number;
  pUp?: number;
  usd: number;
  minutes: number;
  codex: number;
  claude5h: number;
};
export type Step = {
  id: string;
  iteration: number;
  parent: string;
  proposer: 'retro' | 'history' | 'manual' | 'skill';
  hub: string;
  rationale: string;
  diff: string;
  evals: Eval[];
  verdict: 'kept' | 'discarded' | 'screened-out' | 'infra';
  why: string;
  at: string;
};
/** One tune as `/core/compound` answers it; `name` is its folder. */
export type TuneRows = { name: string; tune: Tune; steps: Step[] };

const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

/** The case-weighted quality of a step's evals on `splits`; select (fit and validate) by default. */
export const score = (step: Step, splits: Split[] = ['fit', 'validate']) => {
  const evals = step.evals.filter(e => splits.includes(e.split));
  const n = sum(evals.map(e => e.cases.length));
  return n ? sum(evals.map(e => e.quality * e.cases.length)) / n : undefined;
};

/** The staircase of the best kept score so far, one corner per kept point, running on to the last `x`. */
export const runningBest = (points: { x: number; y?: number | undefined; kept: boolean }[]) => {
  let best = -Infinity;
  const corners = points.flatMap(p =>
    p.kept && p.y !== undefined && p.y > best ? ((best = p.y), [{ x: p.x, y: p.y }]) : []
  );
  const end = Math.max(...points.map(p => p.x));
  return corners.length && end > corners.at(-1)!.x ? [...corners, { x: end, y: best }] : corners;
};

export type Point = ReturnType<typeof seriesOf>[number]['points'][number];

/** One series per tune, steps in order, each with its select score, usage and cumulative usd. */
export const seriesOf = (tunes: TuneRows[]) =>
  tunes
    .map(({ name, tune, steps }) => {
      let cum = 0;
      const points = steps
        .toSorted((a, b) => a.iteration - b.iteration || a.at.localeCompare(b.at))
        .map(step => {
          const usage = (k: 'usd' | 'minutes' | 'codex' | 'claude5h') => sum(step.evals.map(e => e[k]));
          cum += usage('usd');
          return {
            step,
            y: score(step),
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
        init: points.find(p => p.step.iteration === 0)?.y,
      };
    })
    .toSorted((a, b) => Number(a.skill) - Number(b.skill) || a.key.localeCompare(b.key));

export type Series = ReturnType<typeof seriesOf>[number];

/** Per iteration: the best kept score so far and the usd spent by its end. */
export const byIteration = (s: Series) => {
  const last = Math.max(0, ...s.points.map(p => p.step.iteration));
  let best = -Infinity;
  return Array.from({ length: last + 1 }, (_, i) => {
    const at = s.points.filter(p => p.step.iteration === i);
    for (const p of at) if (p.step.verdict === 'kept' && p.y !== undefined) best = Math.max(best, p.y);
    const cum = at.at(-1)?.cum ?? s.points.filter(p => p.step.iteration < i).at(-1)?.cum ?? 0;
    return {
      iteration: i,
      best,
      cum,
      usd: sum(at.map(p => p.usd)),
      minutes: sum(at.map(p => p.minutes)),
      codex: sum(at.map(p => p.codex)),
      claude: sum(at.map(p => p.claude)),
    };
  });
};

/**
 * Per tune name, per iteration: the mean over repos of the running best, the lowest and highest repo, and the mean
 * usage. A tune that stopped early holds its last best.
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
        const bests = at.map(a => a.best);
        return {
          iteration: i,
          best: mean(bests),
          lo: Math.min(...bests),
          hi: Math.max(...bests),
          per: at.map(a => ({ repo: a.repo, best: a.best })),
          cum: mean(at.map(a => a.cum)),
          usd: mean(ran.map(a => a.usd)),
          minutes: mean(ran.map(a => a.minutes)),
          codex: mean(ran.map(a => a.codex)),
          claude: mean(ran.map(a => a.claude)),
        };
      }),
    };
  });
