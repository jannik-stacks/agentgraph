// Turns a data directory's finished runs into anomaly items for the retro judge: one JSON line per invariant and key,
// with what the invariant means, how often it held, the issues and runs that show it and one piece of evidence. Every
// invariant reads only what runs leave behind: run.json, outcome.json, events.jsonl and pulls.jsonl. `--hub` adds
// each check's mode, the check names, each bot's resume setting, each issue's Done when list and each job's until.max;
// without it every failing gating check counts as holding, every bot as resuming its session, and briefs and attempt
// counts go unchecked.
//
//   node retro.mjs <data> [--hub <dir>] [--since <iso time>]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const parse = text => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const json = file => parse(read(file));
const jsonl = file => read(file).split('\n').map(parse).filter(Boolean);

/** Each run under `<data>/runs` created at or after `since`, oldest first. */
export const load = (data, since = '') =>
  readdirSync(join(data, 'runs'))
    .filter(id => id >= since.replace(/[:.]/g, '-'))
    .sort()
    .flatMap(id => {
      const dir = join(data, 'runs', id);
      const run = json(join(dir, 'run.json'));
      const events = jsonl(join(dir, 'events.jsonl')).map(line => ({ ts: line.ts, ...line.event }));
      return run ? [{ id, run, outcome: json(join(dir, 'outcome.json')) ?? {}, events }] : [];
    });

/** The front matter `field` of every `<hub>/<kind>/*.md` that sets it, by name. */
const front = (hub, kind, field) => {
  const dir = hub ? join(hub, kind) : '';
  if (!dir || !existsSync(dir)) return {};
  const value = file => new RegExp(`^${field}:\\s*(\\S+)`, 'm').exec(read(join(dir, file)))?.[1];
  const names = readdirSync(dir).filter(file => file.endsWith('.md'));
  return Object.fromEntries(names.map(file => [file.slice(0, -3), value(file)]).filter(([, v]) => v));
};

/** The number of items in the `Done when` list of issue `n` under `<hub>/issues`. */
const doneWhen = (hub, n) => {
  const dir = hub ? join(hub, 'issues') : '';
  const file = dir && existsSync(dir) && readdirSync(dir).find(f => f.startsWith(`${n}-`));
  return file ? (section(read(join(dir, file)), 'Done when').match(/^[-*] /gm) ?? []).length : 0;
};

/** The `until.max` a workflow under `<hub>/workflows` gives `job`. */
const maxAttempts = (hub, workflow, job) => {
  const lines = hub ? read(join(hub, 'workflows', `${workflow}.md`)).split('\n') : [];
  const indent = line => /^\s*/.exec(line)[0].length;
  const at = lines.findIndex(line => new RegExp(`^\\s+${job}:\\s*$`).test(line));
  const end = lines.findIndex((line, i) => i > at && line.trim() && indent(line) <= indent(lines[at]));
  const block = at < 0 ? '' : lines.slice(at, end < 0 ? undefined : end).join('\n');
  return Number(/until:[\s\S]*?max:\s*(\d+)/.exec(block)?.[1] ?? 0);
};

const said = ['reply', 'ask', 'merge-request', 'label'];
const posted = r => (r.outcome.results ?? []).some(x => said.includes(x.kind) && x.status !== 'failed');
const calls = (r, tool) => r.events.filter(e => e.type === 'tool_call' && tool.test(e.tool));
const edits = r => calls(r, /edit|write|patch/).length;
const accepted = (r, kind) => (r.outcome.accepted ?? []).filter(x => x.kind === kind);
const asks = r => accepted(r, 'ask').map(x => x.question);
const failing = r => (r.outcome.checks ?? []).filter(c => c.gating && !c.pass && !c.skipped);
const findings = r => (r.outcome.checks ?? []).map(c => [c.check, String(c.findings ?? '')]);
const engineAsk = /^checks (still failing|could not run)/i;
const crashed = /^run \S+ failed:/m;
const decisions = r => r.events.filter(e => e.type === 'decision');
/** The subjects of the commits a push result added since `base`, read from its repository when it is on disk. */
const subjects = (result, base) => {
  const repo = (result.url ?? '').split('#')[0];
  if (!result.sha || !repo || !existsSync(repo)) return [];
  const range = base ? [`${base}..${result.sha}`] : ['-n', '20', result.sha];
  try {
    return execFileSync('git', ['--git-dir', repo, 'log', '--format=%s', ...range], { encoding: 'utf8' }).split('\n');
  } catch {
    return [];
  }
};
const recalls = r => r.events.filter(e => e.type === 'recall');
const shown = r => recalls(r).flatMap(e => (e.items ?? []).filter(i => i.fate === 'surfaced' || i.fate === 'unjudged'));
const tokens = r => r.events.reduce((sum, e) => sum + (e.type === 'usage' ? e.inputTokens : 0), 0);
const created = id => Date.parse(id.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-/, 'T$1:$2:$3.'));
const job = r => `${r.run.workflow}/${r.run.job}`;
const attempt = (prev, cur) => cur.run.attempt > 1 && cur.run.parent === prev.id;
const gist = text =>
  text
    .replace(/[^\n -~ -￿]\[[\d;]*m/g, '')
    .replace(/\d{4}-\d\d-\d\dT[\d-]+Z-\w+/g, 'RUN')
    .replace(/\d+/g, 'N')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .slice(0, 120);
const section = (text, heading) =>
  new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text ?? '')?.[1] ?? '';
const places = text => new Set(String(text ?? '').match(/[\w./-]+\.\w+:\d+/g) ?? []);
const testFile = /(^|\/)tests?\/|\.test\./;
const added = (r, keep) =>
  calls(r, /edit|write|patch/)
    .filter(e => keep(e.input?.filePath ?? ''))
    .reduce((sum, { input: i }) => {
      const old = new Set((i.oldString ?? '').split('\n'));
      return sum + (i.newString ?? i.content ?? '').split('\n').filter(l => l.trim() && !old.has(l)).length;
    }, 0);
const words = text => new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
const overlap = (a, b) => [...a].filter(w => b.has(w)).length / Math.max(1, Math.min(a.size, b.size));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const hit = (r, key, detail) => ({
  key,
  run: r.id,
  issue: r.run.event?.number,
  detail: String(detail ?? '').slice(0, 300),
});

const environment = {
  'read-only path': /EROFS|read-only file system/i,
  'no home directory': /uv_os_homedir/,
  'missing binary': /spawnSync \S+ ENOENT/,
  'terminal escapes': /\[\d+(;\d+)*m\S/,
  killed: /exited with code (137|143)\b/,
};

/** The runs of one job on one issue, oldest first, and each with the run before it. */
const chains = jobs => Object.values(Object.groupBy(jobs, r => `${job(r)}#${r.run.event?.number}`));
const pairs = chain => chain.slice(1).map((cur, i) => [chain[i], cur]);

const invariants = {
  'silent-stop': {
    means: 'a job stopped (blocked, deferred or failed) and nothing was posted where a human would see it',
    find: ({ jobs }) =>
      jobs
        .filter(r => ['blocked', 'deferred'].includes(r.run.closure) || r.run.status === 'failed')
        .filter(r => !posted(r) && !/^needs "/.test(r.run.reason ?? ''))
        .map(r =>
          hit(r, `${job(r)}: ${gist(r.run.reason ?? r.run.error ?? r.run.status)}`, r.run.reason ?? r.run.error)
        ),
  },
  'work-lost': {
    means: 'a job that edited code stopped without parking or pushing it, so the next run starts from zero',
    find: ({ jobs, writing }) =>
      jobs
        .filter(r => writing.has(job(r)) && ['blocked', 'deferred'].includes(r.run.closure))
        .filter(r => !r.run.parked && !accepted(r, 'push').length)
        .filter(r => edits(r) || r.run.attempt > 1)
        .map(r => hit(r, job(r), r.run.reason)),
  },
  'stuck-finding': {
    means: 'a gating check failed with the same finding on two runs in a row: the bot cannot or did not fix it',
    find: ({ chains }) =>
      chains.flatMap(chain =>
        pairs(chain).flatMap(([prev, cur]) =>
          failing(cur)
            .filter(c =>
              failing(prev).some(p => p.check === c.check && gist(p.findings ?? '') === gist(c.findings ?? ''))
            )
            .map(c => hit(cur, `${c.check}: ${gist(c.findings ?? '')}`, c.findings))
        )
      ),
  },
  'no-convergence': {
    means: 'three attempts in a row failed gating checks, each on a new finding',
    find: ({ chains }) =>
      chains.flatMap(chain => {
        let streak = [];
        return chain.flatMap(r => {
          const linked = streak.length && attempt(streak.at(-1), r);
          streak = failing(r).length ? (linked ? [...streak, r] : [r]) : [];
          const path = streak
            .map(s =>
              failing(s)
                .map(c => c.check)
                .join('+')
            )
            .join(' then ');
          return streak.length === 3 ? [hit(r, `${job(r)}#${r.run.event?.number}`, path)] : [];
        });
      }),
  },
  'retry-no-holding': {
    means: 'an attempt was retried although no failing check of the one before blocks',
    find: ({ chains, modes }) =>
      chains.flatMap(chain =>
        pairs(chain)
          .filter(([prev, cur]) => attempt(prev, cur) && !prev.run.error)
          .filter(([prev]) => !failing(prev).some(c => (modes[c.check] ?? 'block') === 'block'))
          .map(([prev, cur]) =>
            hit(
              cur,
              job(cur),
              failing(prev)
                .map(c => c.check)
                .join(', ') || 'nothing failed'
            )
          )
      ),
  },
  'park-on-open-request': {
    means: 'parked, unchecked work was pushed to a branch with an open merge request',
    find: ({ jobs, pulls }) =>
      jobs
        .filter(r => r.run.parked)
        .flatMap(r => {
          const before = pulls.filter(p => p.ts <= (r.run.endedAt ?? ''));
          const shut = n => before.some(p => p.number === n && (p.op === 'merge' || p.op === 'close'));
          const open = before.filter(p => p.op === 'open' && p.branch === r.run.parked && !shut(p.number));
          return open.map(p => hit(r, r.run.parked, `parked onto open request #${p.number}`));
        }),
  },
  'no-session': {
    means: 'an opencode bot set to resume its session never recorded a session id, so it cannot resume',
    find: ({ jobs, resume }) =>
      jobs
        .filter(r => r.run.harness === 'opencode' && resume(r.run.bot) === 'session')
        .filter(r => r.events.some(e => e.type === 'start') && !r.events.some(e => e.session))
        .map(r => hit(r, r.run.bot, 'no start event carries a session id')),
  },
  rejected: {
    means: "bothub found a bot's proposal invalid, so the work its reply describes never landed",
    find: ({ jobs }) =>
      jobs.flatMap(r =>
        (r.outcome.rejected ?? [])
          .filter(x => !/^(the bot stopped|checks (still failing|could not run))/.test(x.reason ?? ''))
          .map(x => hit(r, `${job(r)}: ${x.proposal?.kind}: ${gist(x.reason ?? '')}`, x.reason))
      ),
  },
  'engine-ask': {
    means: 'bothub itself asked a human because checks kept failing or could not run',
    find: ({ jobs }) =>
      jobs.flatMap(r =>
        asks(r)
          .filter(q => engineAsk.test(q))
          .map(q => hit(r, job(r), q))
      ),
  },
  'ask-about-check': {
    means: 'a bot asked a human about a check or a hub limit, which an answer cannot change',
    find: ({ jobs, checks }) => {
      const named = c =>
        new RegExp(c.includes('-') ? `\\b${c}\\b` : `\`${c}\`|\\b${c} (check|finding|cap|limit|threshold)`, 'i');
      const limit = /allowed (edit )?paths|\b(file|size) cap\b|raise the (cap|limit)/i;
      return jobs.flatMap(r =>
        asks(r)
          .filter(q => !engineAsk.test(q))
          .flatMap(q =>
            [...checks.filter(c => named(c).test(q)), ...(limit.test(q) ? ['hub limit'] : [])].map(c => hit(r, c, q))
          )
      );
    },
  },
  'asked-untried': {
    means: 'a job that writes code asked a human on its first attempt without editing anything',
    find: ({ jobs, writing }) =>
      jobs
        .filter(r => writing.has(job(r)) && !r.run.parent && !edits(r) && asks(r).length)
        .map(r => hit(r, `${job(r)}#${r.run.event?.number}`, asks(r)[0])),
  },
  'same-ask': {
    means: 'the same question was asked twice on one issue',
    find: ({ jobs }) => {
      const seen = new Map();
      return jobs.flatMap(r =>
        asks(r).flatMap(question => {
          const issue = r.run.event?.number;
          const earlier = (seen.get(issue) ?? []).find(q => overlap(words(q), words(question)) >= 0.6);
          seen.set(issue, [...(seen.get(issue) ?? []), question]);
          return earlier ? [hit(r, `#${issue}: ${gist(earlier)}`, question)] : [];
        })
      );
    },
  },
  'cut-title': {
    means: "an ask's title, its first line, is cut off or stops mid-sentence",
    find: ({ jobs }) =>
      jobs.flatMap(r =>
        asks(r)
          .map(q => q.trim().split('\n')[0])
          .filter(line => line.length > 80 || !/[?.!]$/.test(line))
          .map(line => hit(r, job(r), line))
      ),
  },
  'crashed-handoff': {
    means: 'a job handed off while one of its check runs had crashed, so that check never judged the change',
    find: ({ jobs }) =>
      jobs
        .filter(r => r.run.closure === 'handed-off')
        .flatMap(r =>
          findings(r)
            .filter(([, text]) => crashed.test(text))
            .map(([check, text]) => hit(r, job(r), `${check}: ${/^run \S+ failed:.*/m.exec(text)[0]}`))
        ),
  },
  'test-heavy': {
    means: 'a change under 10 source lines added more than 10 times as many test lines',
    find: ({ chains, writing }) =>
      chains
        .filter(chain => writing.has(job(chain[0])))
        .flatMap(chain => {
          const sum = keep => chain.reduce((n, r) => n + added(r, keep), 0);
          const tests = sum(f => testFile.test(f));
          const source = sum(f => /\.[cm]?[jt]sx?$/.test(f) && !testFile.test(f));
          return source < 10 && tests > 10 * Math.max(1, source)
            ? [hit(chain.at(-1), job(chain[0]), `${tests} test lines for ${source} source lines`)]
            : [];
        }),
  },
  'wide-brief': {
    means: "a brief has more criteria than the issue's Done when items plus one",
    find: ({ jobs, hub }) =>
      jobs.flatMap(r =>
        accepted(r, 'reply').flatMap(x => {
          const criteria = (section(x.body, 'Criteria').match(/^\d+\.\s/gm) ?? []).length;
          const done = doneWhen(hub, r.run.event?.number);
          return done && criteria > done + 1 ? [hit(r, job(r), `${criteria} criteria for ${done} Done when items`)] : [];
        })
      ),
  },
  'same-line': {
    means: 'a new run on an issue failed the same check on the same line as the run before it',
    find: ({ chains }) =>
      chains.flatMap(chain =>
        pairs(chain.filter(r => (r.outcome.checks ?? []).some(c => !c.skipped)))
          .filter(([prev, cur]) => !attempt(prev, cur))
          .flatMap(([prev, cur]) =>
            failing(cur).flatMap(c => {
              const before = failing(prev).filter(p => p.check === c.check).flatMap(p => [...places(p.findings)]);
              const same = [...places(c.findings)].filter(place => before.includes(place));
              return same.map(place => hit(cur, `${c.check}: ${place}`, c.findings));
            })
          )
      ),
  },
  'over-attempts': {
    means: "a job ran more attempts on one issue than its until.max, so a new run reset the count",
    find: ({ chains, writing, hub }) =>
      chains
        .filter(chain => writing.has(job(chain[0])))
        .flatMap(chain => {
          const max = maxAttempts(hub, chain[0].run.workflow, chain[0].run.job);
          const ran = chain.filter(r => r.run.status !== 'skipped');
          return max && ran.length > max
            ? [hit(ran.at(-1), `${job(chain[0])}#${chain[0].run.event?.number}`, `${ran.length} attempts, until.max ${max}`)]
            : [];
        }),
  },
  'empty-retrigger': {
    means: 'after bothub asked about its checks, the next turn changed nothing and only re-ran them',
    find: ({ chains }) =>
      chains.flatMap(chain =>
        pairs(chain)
          .filter(([prev, cur]) => asks(prev).some(q => engineAsk.test(q)) && !edits(cur) && cur.run.bot)
          .map(([prev, cur]) => hit(cur, job(cur), `no edit after ${prev.id} asked: ${asks(prev)[0]}`))
      ),
  },
  'shipped-gaps': {
    means: 'a job handed off while a warn or log check still failed on it',
    find: ({ jobs, modes }) =>
      jobs
        .filter(r => r.run.closure === 'handed-off')
        .flatMap(r =>
          (r.outcome.checks ?? [])
            .filter(c => !c.pass && !c.skipped && !crashed.test(String(c.findings ?? '')))
            .filter(c => !c.gating || ['warn', 'log'].includes(modes[c.check]))
            .map(c => hit(r, c.check, c.findings))
        ),
  },
  'fast-script-fail': {
    means: 'an attempt failed only on script checks under 10 s, which the bot could have run before finishing',
    find: ({ jobs, types }) =>
      jobs
        .filter(r => failing(r).length && failing(r).every(c => types[c.check] === 'script' && c.durationMs < 10_000))
        .map(r =>
          hit(
            r,
            failing(r)
              .map(c => c.check)
              .join('+'),
            failing(r)[0].findings
          )
        ),
  },
  'parked-pushed': {
    means: 'a commit made to park unchecked work was pushed as part of the change',
    find: ({ jobs }) =>
      jobs.flatMap(r =>
        (r.outcome.results ?? [])
          .filter(x => x.kind === 'push' && x.status === 'applied')
          .flatMap(x => subjects(x, r.run.base).filter(s => s.includes('(parked)')))
          .map(subject => hit(r, job(r), subject))
      ),
  },
  'no-block': {
    means: "a bot's reply had no bothub block, so its work was thrown away",
    find: ({ jobs }) =>
      jobs.filter(r => /no bothub block/.test(r.run.error ?? r.run.reason ?? '')).map(r => hit(r, job(r), r.run.error)),
  },
  'no-verdict': {
    means: 'a bot check reply had no PASS or FAIL the engine could read',
    find: ({ runs }) =>
      runs.flatMap(r =>
        findings(r).flatMap(([check, text]) => (/gave no verdict/.test(text) ? [hit(r, check, text)] : []))
      ),
  },
  'over-max': {
    means: 'a check could not judge because its item count exceeded its max',
    find: ({ runs }) =>
      runs.flatMap(r =>
        findings(r)
          .filter(([, text]) => /more than "max" allows|"each-hunk" takes/.test(text))
          .map(([check, text]) => hit(r, check, text))
      ),
  },
  budget: {
    means: "a bot's daily run budget stopped a job or a check",
    find: ({ runs }) =>
      runs.flatMap(r =>
        [r.run.reason ?? '', ...findings(r).map(([, text]) => text)].flatMap(text => {
          const m = /bot "([\w-]+)" used its (\d+) runs/.exec(text);
          return m ? [hit(r, `${m[1]} at ${m[2]} a day`, m[0])] : [];
        })
      ),
  },
  'env-error': {
    means:
      'the sandbox environment, not the change, broke a command: a read-only path, a missing binary or home, terminal escapes',
    find: ({ jobs }) =>
      jobs.flatMap(r => {
        const texts = [r.run.reason, r.run.error, ...findings(r).map(([, t]) => t), ...asks(r)];
        const lines = [...texts, ...accepted(r, 'reply').map(x => x.body)].join('\n').split('\n');
        return Object.entries(environment).flatMap(([name, pattern]) => {
          const line = lines.find(l => pattern.test(l));
          return line ? [hit(r, name, line)] : [];
        });
      }),
  },
  'failed-read': {
    means: 'runs tried to read the same missing file: a prompt or skill points at something that is not there',
    find: ({ runs }) => {
      const failed = runs.flatMap(r => {
        const ok = new Map(r.events.filter(e => e.type === 'tool_result').map(e => [e.id, e.ok]));
        return calls(r, /^read$/).flatMap(e =>
          ok.get(e.id) === false ? [hit(r, e.input?.filePath, e.input?.filePath)] : []
        );
      });
      const runsOf = path => new Set(failed.filter(h => h.key === path).map(h => h.run)).size;
      return failed.filter(h => runsOf(h.key) > 1);
    },
  },
  'rerun-done': {
    means: 'a job that had already finished on an issue ran again from scratch',
    find: ({ chains }) =>
      chains.flatMap(chain =>
        pairs(chain)
          .filter(
            ([prev, cur]) =>
              ['done', 'handed-off'].includes(prev.run.closure) && !cur.run.parent && cur.run.status !== 'skipped'
          )
          .map(([prev, cur]) => hit(cur, job(cur), `${prev.id} had closed ${prev.run.closure}`))
      ),
  },
  'recheck-unchanged': {
    means: 'checks ran again on an attempt that edited nothing',
    find: ({ jobs }) =>
      jobs
        .filter(
          r => r.run.attempt > 1 && !edits(r) && (r.outcome.checks ?? []).some(c => !c.skipped && c.durationMs > 10_000)
        )
        .map(r => hit(r, job(r), (r.outcome.checks ?? []).map(c => c.check).join(', '))),
  },
  'waits-on-log': {
    means: 'a check that does not gate finished more than a minute after every gating check, so the job waited on it',
    find: ({ jobs }) =>
      jobs.flatMap(r => {
        const ran = (r.outcome.checks ?? []).filter(c => !c.skipped && c.endedAt);
        const gate = Math.max(0, ...ran.filter(c => c.gating).map(c => Date.parse(c.endedAt)));
        const late = ran.filter(c => !c.gating && Date.parse(c.endedAt) - gate > 60_000);
        return gate
          ? late.map(c => hit(r, c.check, `${Math.round((Date.parse(c.endedAt) - gate) / 1000)} s after`))
          : [];
      }),
  },
  'no-op-run': {
    means: 'a script job ran and changed nothing',
    find: ({ jobs }) =>
      jobs
        .filter(r => !r.run.bot && r.outcome.results?.length)
        .filter(r => r.outcome.results.every(x => x.status === 'skipped' || /already/.test(x.reason ?? '')))
        .map(r => hit(r, job(r), r.outcome.results.map(x => x.reason).join('; '))),
  },
  'check-rereads': {
    means: 'a check run read three or more files, though its item should hold what it judges',
    find: ({ runs }) =>
      runs
        .filter(r => r.run.check && calls(r, /^read$/).length >= 3)
        .map(r => hit(r, r.run.check, `${calls(r, /^read$/).length} reads`)),
  },
  'token-outlier': {
    means: 'a run read more than three times the typical input tokens of its job or check',
    find: ({ runs }) =>
      Object.entries(Object.groupBy(runs, r => r.run.check ?? r.run.job)).flatMap(([name, rs]) => {
        const typical = median(rs.map(tokens));
        const big = rs.filter(r => tokens(r) > 3 * typical && tokens(r) > 100_000);
        return rs.length < 5 ? [] : big.map(r => hit(r, name, `${tokens(r)} input tokens, typical ${typical}`));
      }),
  },
  'slow-start': {
    means: 'a run waited more than a minute before its first event: a queue, a limiter or a slow model start',
    find: ({ runs }) =>
      runs.flatMap(r => {
        const wait = (Date.parse(r.events[0]?.ts) - (r.run.check ? created(r.id) : Date.parse(r.run.startedAt))) / 1000;
        return wait > 60
          ? [hit(r, `${r.run.bot ?? 'script'}${r.run.check ? ' checks' : ' jobs'}`, `${Math.round(wait)} s`)]
          : [];
      }),
  },
  'recall-query': {
    means: 'recall searched with the event header instead of the task',
    find: ({ runs }) =>
      runs.flatMap(r =>
        recalls(r)
          .filter(e => /^## Event/.test(e.query ?? ''))
          .map(e => hit(r, 'event header', e.query))
      ),
  },
  'recall-into-check': {
    means: "a check run was shown earlier runs' summaries, which can anchor its verdict",
    find: ({ runs }) =>
      runs.flatMap(r => {
        const summaries = r.run.check ? shown(r).filter(i => i.kind === 'summary') : [];
        return summaries.length ? [hit(r, r.run.check, summaries.map(i => i.pointer).join(', '))] : [];
      }),
  },
  'recall-unused': {
    means: 'recall showed notes or summaries and the run never read or named any of them',
    find: ({ runs }) =>
      runs.flatMap(r => {
        const later = JSON.stringify(r.events.filter(e => e.type === 'tool_call' || e.type === 'text'));
        const slug = pointer => pointer.replace(/^notes\/\w+\//, '').replace(/\.md$|#.*$/g, '');
        const items = shown(r);
        const unused = items.length && !items.some(i => later.includes(slug(i.pointer)));
        return unused ? [hit(r, r.run.check ? 'check runs' : 'job runs', `${items.length} shown, none used`)] : [];
      }),
  },
  'recall-flat': {
    means: 'the recall judge gave nearly the same score to every candidate, so it does not rank',
    find: ({ runs }) =>
      runs.flatMap(r =>
        recalls(r).flatMap(e => {
          const ps = (e.items ?? []).map(i => i.p).filter(p => p !== undefined);
          return ps.length >= 5 && Math.max(...ps) - Math.min(...ps) < 0.15
            ? [hit(r, 'recall judge', ps.join(' '))]
            : [];
        })
      ),
  },
  'decider-flat': {
    means: 'a decider gave nearly the same score to every call it judged, so it does not separate them',
    find: ({ runs }) =>
      Object.entries(Object.groupBy(runs.flatMap(decisions), e => e.ask)).flatMap(([ask, es]) => {
        const ps = es.map(e => e.p).filter(p => p !== undefined);
        const last = runs.findLast(r => decisions(r).some(e => e.ask === ask));
        return ps.length >= 5 && Math.max(...ps) - Math.min(...ps) < 0.15
          ? [hit(last, ask, `${ps.length} scores from ${Math.min(...ps).toFixed(2)} to ${Math.max(...ps).toFixed(2)}`)]
          : [];
      }),
  },
  'decider-error': {
    means: 'a decider call failed, so the call it judged went through unjudged',
    find: ({ runs }) =>
      runs.flatMap(r =>
        decisions(r)
          .filter(e => e.error)
          .map(e => hit(r, gist(e.error), e.error))
      ),
  },
  'recall-error': {
    means: 'recall failed',
    find: ({ runs }) =>
      runs.flatMap(r =>
        recalls(r)
          .filter(e => e.error)
          .map(e => hit(r, gist(e.error), e.error))
      ),
  },
  unmetered: {
    means: 'recall judged candidates and no usage record counts its tokens',
    find: ({ runs }) =>
      runs
        .filter(r => shown(r).some(i => i.p !== undefined) && !r.events.some(e => e.source === 'recall'))
        .map(r => hit(r, 'recall judge')),
  },
};

/** The anomaly items, most telling invariant first: one per invariant and key, with its hits and up to five runs. */
export const retro = (runs, { hub, pulls = [] } = {}) => {
  const jobs = runs.filter(r => !r.run.check && !['queued', 'running'].includes(r.run.status));
  const resumes = front(hub, 'bots', 'resume');
  const ctx = {
    runs,
    jobs,
    chains: chains(jobs),
    writing: new Set(jobs.filter(r => accepted(r, 'push').length).map(job)),
    pulls,
    hub,
    modes: front(hub, 'checks', 'mode'),
    types: front(hub, 'checks', 'type'),
    checks: Object.keys(front(hub, 'checks', 'type')),
    resume: bot => (hub ? (resumes[bot] ?? 'none') : 'session'),
  };
  return Object.entries(invariants).flatMap(([invariant, { means, find }]) =>
    Object.entries(Object.groupBy(find(ctx), h => h.key)).map(([key, hits]) => ({
      id: `retro:${createHash('sha256').update(`${invariant}: ${key}`).digest('hex').slice(0, 8)}`,
      key: `${invariant}: ${key}`,
      invariant,
      means,
      count: hits.length,
      issues: [...new Set(hits.map(h => h.issue).filter(n => n !== undefined))],
      runs: hits.slice(0, 5).map(h => h.run),
      evidence: hits[0].detail,
    }))
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = name => (args.includes(name) ? args.splice(args.indexOf(name), 2)[1] : undefined);
  const hub = flag('--hub');
  const since = flag('--since');
  if (!args[0]) {
    console.error('usage: node retro.mjs <data> [--hub <dir>] [--since <iso time>]');
    process.exit(2);
  }
  const pulls = jsonl(join(args[0], 'pulls.jsonl'));
  for (const item of retro(load(args[0], since), { hub, pulls })) console.log(JSON.stringify(item));
}
