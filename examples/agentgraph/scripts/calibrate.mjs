// Asks each candidate model a check's question about every labelled item in a fixture and prints how well the
// answers separate the items expected to pass from those expected to fail. Run it on the host, not in a check.
//
//   node calibrate.mjs [--env <file>] [--models a,b] <checks-dir> <fixture.jsonl>...
//
// A fixture line is {"item": <text or object>, "expect": "yes" | "no", "source": "..."}; the check is the fixture's
// base name in <checks-dir>, and its body is the question. Candidates are `decide:<ollama model>`, asked through
// /v1/systemone for the probability of yes, and `chat:<LiteLLM alias>`, asked for PASS or FAIL on the first line.
// The key comes from AGENTGRAPH_LLM_API_KEY, or LITELLM_MASTER_KEY in the --env file; it is never printed.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const option = name => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args.splice(at, 2)[1];
};
const envFile = option('--env');
const fileEnv = envFile
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter(line => /^[A-Z_]+=/.test(line))
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')])
    )
  : {};
const env = { ...fileEnv, ...process.env };
const models = (option('--models') ?? 'decide:tev1:0.8b,chat:fast,chat:smart').split(',');
const [checks, ...fixtures] = args;
if (!checks || !fixtures.length) throw new Error('usage: calibrate.mjs [--env <file>] [--models a,b] <checks-dir> <fixture.jsonl>...');

const decideUrl = (env.AGENTGRAPH_DECIDE_URL || 'http://127.0.0.1:11434').replace('ollama.internal', '127.0.0.1');
const llmUrl = (env.AGENTGRAPH_LLM_BASE_URL || 'http://127.0.0.1:4000/v1').replace('litellm:', '127.0.0.1:');
const key = env.AGENTGRAPH_LLM_API_KEY || env.LITELLM_MASTER_KEY;

const bodyOf = text => text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
const contract = 'Answer on the first line with exactly PASS or FAIL and nothing before it. Findings, if any, follow.';

const decide = async (model, question, state) => {
  const response = await fetch(`${decideUrl}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, state, questions: { answer: { type: 'noul', instructions: question } } }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? response.status);
  return json.answers.answer.noul;
};

/** The text of a LiteLLM /v1/responses call, which streams for the subscription models. */
const respond = async (alias, prompt) => {
  const response = await fetch(`${llmUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: alias, instructions: 'You judge one item.', input: [{ role: 'user', content: prompt }], store: false }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(raw.slice(0, 200));
  const events = raw.startsWith('{') ? [{ type: 'response.completed', response: JSON.parse(raw) }] : raw
    .split('\n')
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6)));
  const deltas = events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join('');
  const done = events.find(e => e.type === 'response.completed')?.response ?? {};
  return deltas || (done.output ?? []).flatMap(o => o.content ?? []).map(c => c.text ?? '').join('');
};

const chat = async (alias, question, state) => {
  const yesNo = question.includes('PASS') ? '' : '\nPASS means yes, FAIL means no.';
  const text = await respond(alias, `${question}${yesNo}\n\n${contract}\n\n## Item\n\n${state}`);
  const word = (text.trim().split('\n')[0] ?? '').replace(/[\s*_`]/g, '').toUpperCase();
  if (word === 'PASS' || word === 'FAIL') return Number(word === 'PASS');
  console.error(`${alias} gave no verdict: ${JSON.stringify(text.slice(0, 200))}`);
  return null;
};

const ask = (model, question, state) =>
  model.startsWith('decide:') ? decide(model.slice(7), question, state) : chat(model.slice(5), question, state);

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** The threshold that classifies the most items right, halfway between neighbouring scores. */
const bestThreshold = rows => {
  const scores = [...new Set(rows.map(r => r.score))].sort((a, b) => a - b);
  const cuts = [0, ...scores.slice(1).map((s, i) => (s + scores[i]) / 2), 1.01];
  let best = { cut: 0.5, right: -1 };
  for (const cut of cuts) {
    const right = rows.filter(r => (r.score >= cut) === (r.expect === 'yes')).length;
    if (right > best.right) best = { cut, right };
  }
  return best;
};

console.log('check\tmodel\tgood mean\tbad mean\tno verdict\tthreshold\tright');
for (const fixture of fixtures) {
  const name = basename(fixture, '.jsonl');
  const question = bodyOf(readFileSync(join(checks, `${name}.md`), 'utf8'));
  const items = readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const model of models) {
    const rows = [];
    for (const { item, expect } of items) {
      const state = typeof item === 'string' ? item : JSON.stringify(item);
      let score;
      try {
        score = await ask(model, question, state);
      } catch (e) {
        score = undefined;
        console.error(`${name} ${model}: ${String(e.message ?? e).slice(0, 160)}`);
      }
      rows.push({ expect, score });
    }
    const judged = rows.filter(r => typeof r.score === 'number');
    const good = judged.filter(r => r.expect === 'yes').map(r => r.score);
    const bad = judged.filter(r => r.expect === 'no').map(r => r.score);
    const { cut, right } = bestThreshold(judged);
    const f = n => (Number.isNaN(n) ? '-' : n.toFixed(2));
    console.log([name, model, f(mean(good)), f(mean(bad)), rows.length - judged.length, f(cut), `${right}/${rows.length}`].join('\t'));
  }
}
