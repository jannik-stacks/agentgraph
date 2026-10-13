// Fails a triage reply that breaks the brief template: the four sections in order, at most five criteria, and each
// criterion one line ending in the test title and test file that prove it. Every file the brief names must sit under
// the paths in bounds.mjs, or the roots `--within` gives, have a name the safety check accepts, and the files outside
// tests/ must fit the size check's cap. Every path the issue's Done when names must sit under those paths too, unless
// the brief lists it as out of scope.
//
//   node triage-brief.mjs [--within <root>,<root>...] [reply-file]      otherwise the reply is read from BOTHUB_REPLY
import { existsSync, readFileSync } from 'node:fs';
import { capped, maxFiles, paths, rejects } from './bounds.mjs';
import { findIssue, parseBrief } from './brief.mjs';
import { report } from './changes.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--within');
const roots = at === -1 ? paths : args.splice(at, 2)[1].split(',').filter(Boolean);
const reply = args[0] ? readFileSync(args[0], 'utf8') : process.env.BOTHUB_REPLY;
if (reply === undefined) console.log('triage-brief: no reply to check; it is read from BOTHUB_REPLY');
else {
  const { files, outOfScope, problems } = parseBrief(reply);
  const inside = path => roots.some(root => path.startsWith(root));
  for (const file of files.filter(file => !inside(file)))
    problems.push(`${file} is outside what the change may touch (${roots.join(', ')}); leave it out of scope or ask`);
  for (const file of new Set(files))
    for (const why of rejects(file, !existsSync(file))) problems.push(`${file}: the safety check would fail it: ${why}`);
  const done = /^## Done when\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(findIssue() ?? '')?.[1] ?? '';
  for (const path of new Set(done.match(/`[\w.-]+\/[\w./-]*`/g)?.map(quoted => quoted.slice(1, -1))))
    if (!inside(path) && !outOfScope.some(line => line.includes(path)))
      problems.push(
        `the issue's Done when names ${path}, outside what the change may touch (${roots.join(', ')}); ask to allow it, or list it under "## Out of scope"`
      );
  const counted = [...new Set(files.filter(capped))];
  if (counted.length > maxFiles)
    problems.push(
      `${counted.length} files outside tests/, more than the size check's cap of ${maxFiles}; split the task into tasks that each fit and ask which comes first`
    );
  report('triage-brief', problems);
}
