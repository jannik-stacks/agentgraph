// Fails a triage reply that breaks the brief template: the four sections in order, at most five criteria, and each
// criterion one line ending in the test title and test file that prove it. Every file the brief names must sit under
// the paths in bounds.mjs, or the roots `--within` gives, and the files outside tests/ must fit the size check's cap.
//
//   node triage-brief.mjs [--within <root>,<root>...] [reply-file]      otherwise the reply is read from BOTHUB_REPLY
import { readFileSync } from 'node:fs';
import { capped, maxFiles, paths } from './bounds.mjs';
import { parseBrief } from './brief.mjs';
import { report } from './changes.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--within');
const roots = at === -1 ? paths : args.splice(at, 2)[1].split(',').filter(Boolean);
const reply = args[0] ? readFileSync(args[0], 'utf8') : process.env.BOTHUB_REPLY;
if (reply === undefined) console.log('triage-brief: no reply to check; it is read from BOTHUB_REPLY');
else {
  const { files, problems } = parseBrief(reply);
  for (const file of files.filter(file => !roots.some(root => file.startsWith(root))))
    problems.push(`${file} is outside what the change may touch (${roots.join(', ')}); leave it out of scope or ask`);
  const counted = [...new Set(files.filter(capped))];
  if (counted.length > maxFiles)
    problems.push(
      `${counted.length} files outside tests/, more than the size check's cap of ${maxFiles}; split the task into tasks that each fit and ask which comes first`
    );
  report('triage-brief', problems);
}
