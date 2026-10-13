// Fails a change that writes a harness's own memory files. What a bot learns goes into the hub as a proposed note,
// so a human reviews it and every harness gets it.
import { base, changedFiles, report } from './changes.mjs';

const memory = [
  [/(^|\/)AGENTS\.md$/, 'AGENTS.md'],
  [/(^|\/)CLAUDE(\.local)?\.md$/, 'CLAUDE.md'],
  [/(^|\/)\.opencode\//, '.opencode/'],
];

const findings = [];
for (const { path } of changedFiles(base()))
  for (const [pattern, what] of memory)
    if (pattern.test(path)) findings.push(`${path}: writes harness memory (${what}); propose a note instead`);
report('harness-memory', findings);
