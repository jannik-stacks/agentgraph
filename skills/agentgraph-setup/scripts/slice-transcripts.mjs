import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

if (process.argv.includes('--help')) {
  console.log(
    `usage: node slice-transcripts.mjs [repo] [--days 90] [--include-automated]\n\nPrints one JSON line per message a person typed to Claude Code or Codex in sessions whose working directory is this repo or a folder inside it. Tool output, injected context, automated runs, subagents and messages older than --days are left out, and each message is clipped and scrubbed of emails, home paths and key-like strings. Run it only after the user says yes, and keep its output outside the repo.`
  );
  process.exit(0);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { days: { type: 'string', default: '90' }, 'include-automated': { type: 'boolean', default: false } },
});
const repo = realpathSync(resolve(positionals[0] ?? '.'));
const since = Date.now() - Number(values.days) * 86_400_000;
const automated = values['include-automated'];
const home = homedir();

const isInRepo = cwd => {
  if (typeof cwd !== 'string') return false;
  const real = existsSync(cwd) ? realpathSync(cwd) : cwd;
  return real === repo || real.startsWith(repo + sep);
};
const blocks =
  /<(environment_context|user_instructions|system-reminder|local-command-[\w-]+|command-[\w-]+|bash-[\w-]+|task-notification|pasted_content|turn_aborted|skill|codex_[\w-]+|permissions|INSTRUCTIONS)\b[^>]*>[\s\S]*?(<\/\1>|$)/g;
const injected = /^\s*(# AGENTS\.md instructions|Caveat: |\[Request interrupted)/;
const trivial =
  /^\s*(ok(ay)?|yes|no|y|n|go|continue|go on|proceed|thanks?|thank you|ty|lgtm|done|next|retry|try again|\/\w+)[.!]*\s*$/i;
const scrub = text =>
  text
    .replaceAll(home, '~')
    .replace(/\/(Users|home)\/[^/\s]+/g, '~')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(
      /\b(sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]{10,})\b/g,
      '<secret>'
    )
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '<secret>');
const clip = text => (text.length > 800 ? `${text.slice(0, 800)} [clipped ${text.length - 800} chars]` : text);
const sessionId = path => createHash('sha256').update(path).digest('hex').slice(0, 8);
const emit = (source, path, at, raw) => {
  const time = Date.parse(at);
  const text = (raw ?? '').replace(blocks, '').trim();
  if (!(time >= since) || !text || injected.test(text) || trivial.test(text)) return;
  console.log(JSON.stringify({ source, session: sessionId(path), at: at.slice(0, 10), text: clip(scrub(text)) }));
};
const recent = path => statSync(path).mtimeMs >= since;
const jsonLines = async function* (path) {
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    try {
      yield JSON.parse(line);
    } catch {}
  }
};
const walk = dir =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        .map(e => join(e.parentPath, e.name))
    : [];

let claudeSessions = 0;
for (const path of walk(join(home, '.claude', 'projects')).filter(recent)) {
  if (path.includes(`${sep}subagents${sep}`)) continue;
  let counted = false;
  for await (const r of jsonLines(path)) {
    if (r.type !== 'user' || r.isMeta || r.isSidechain || !isInRepo(r.cwd)) continue;
    if (!automated && typeof r.entrypoint === 'string' && r.entrypoint.startsWith('sdk')) break;
    const content = r.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n')
          : '';
    if (!counted) claudeSessions += counted = 1;
    emit('claude', path, r.timestamp, text);
  }
}

let codexSessions = 0;
for (const path of walk(join(process.env.CODEX_HOME ?? join(home, '.codex'), 'sessions')).filter(recent)) {
  let keep = false;
  let counted = false;
  const typed = [];
  const items = [];
  for await (const r of jsonLines(path)) {
    const p = r.payload ?? {};
    if (r.type === 'session_meta') {
      const byPerson =
        automated ||
        (p.originator !== 'codex_exec' &&
          typeof p.source === 'string' &&
          p.source !== 'exec' &&
          (p.thread_source ?? 'user') === 'user');
      if (!byPerson) break;
      keep = isInRepo(p.cwd);
      counted ||= keep;
      continue;
    }
    if (r.type === 'turn_context') keep = isInRepo(p.cwd);
    if (!keep) continue;
    if (r.type === 'event_msg' && p.type === 'user_message') typed.push([r.timestamp, p.message]);
    if (r.type === 'response_item' && p.type === 'message' && p.role === 'user')
      for (const c of p.content ?? []) if (c.type === 'input_text') items.push([r.timestamp, c.text]);
  }
  if (counted) codexSessions++;
  for (const [at, text] of typed.length ? typed : items) emit('codex', path, at, text);
}
console.error(
  `read ${claudeSessions} Claude Code and ${codexSessions} Codex sessions in ${repo.replace(home, '~')} from the last ${values.days} days`
);
