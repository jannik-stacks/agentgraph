// The exports a commit already has, and those whose names share a word with a new name, so a judge can say whether
// one of them already does the new code's job.
import { execFileSync } from 'node:child_process';

export const declaration = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/;
const generic = new Set(['options', 'type', 'types', 'result', 'value', 'data', 'input', 'output', 'default', 'props']);
const words = name =>
  name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word.length > 2 && !generic.has(word));

const grep = (sha, pathspecs) => {
  try {
    return execFileSync('git', ['grep', '-n', '-E', '^export ', sha, '--', ...pathspecs], { encoding: 'utf8' });
  } catch (e) {
    if (e.status === 1) return '';
    throw e;
  }
};

/** The exported declarations under `pathspecs` at `sha`, each with its file, line, name and code. */
export const existingExports = (sha, pathspecs) =>
  grep(sha, pathspecs)
    .split('\n')
    .flatMap(row => {
      const m = /^[^:]+:([^:]+):(\d+):(.*)$/.exec(row);
      const name = m && declaration.exec(m[3])?.[1];
      return name ? [{ file: m[1], line: Number(m[2]), name, code: m[3].trim().slice(0, 160) }] : [];
    });

/** The existing exports whose names share a word with `name`, as `file:line: code`, each with how many words. */
export const sharingWords = (name, existing) => {
  const mine = new Set(words(name));
  return existing
    .filter(e => e.name !== name)
    .map(e => [`${e.file}:${e.line}: ${e.code}`, words(e.name).filter(word => mine.has(word)).length])
    .filter(([, shared]) => shared);
};
