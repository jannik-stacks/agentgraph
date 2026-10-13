// Fails a triage reply that breaks the brief template: the four sections in order, at most five criteria, and each
// criterion one line ending in the test title and test file that prove it. With `--within`, every file the brief
// names must sit under one of those roots, the ones the implement job's safety check allows.
//
//   node triage-brief.mjs [--within <root>,<root>...] [reply-file]      otherwise the reply is read from BOTHUB_REPLY
import { readFileSync } from 'node:fs';
import { parseBrief } from './brief.mjs';
import { report } from './changes.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--within');
const roots = at === -1 ? [] : args.splice(at, 2)[1].split(',').filter(Boolean);
const reply = args[0] ? readFileSync(args[0], 'utf8') : process.env.BOTHUB_REPLY;
if (reply === undefined) console.log('triage-brief: no reply to check; it is read from BOTHUB_REPLY');
else {
  const { files, problems } = parseBrief(reply);
  const outside = roots.length ? files.filter(file => !roots.some(root => file.startsWith(root))) : [];
  for (const file of outside)
    problems.push(`${file} is outside what the change may touch (${roots.join(', ')}); leave it out of scope or ask`);
  report('triage-brief', problems);
}
