import { lineChanges, report } from './changes.mjs';

const rules = [];

const hits = (lines, pattern) =>
  lines.reduce(
    (sum, line) =>
      sum + (line.match(new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`))?.length ?? 0),
    0
  );

const findings = [];
for (const [file, change] of lineChanges())
  for (const rule of rules.filter(r => r.files.test(file))) {
    if (hits(change.added, rule.hit) <= hits(change.removed, rule.hit)) continue;
    const examples = change.added.filter(line => hits([line], rule.hit)).slice(0, 3);
    findings.push(`${file}: ${rule.message}\n  ${examples.map(l => l.trim()).join('\n  ')}`);
  }
report(findings);
