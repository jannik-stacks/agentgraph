// What a change may touch and how big it may be. The safety, size and triage-brief checks read these.

/** The paths a change may touch. */
export const paths = ['src/', 'tests/', 'studio/src/', 'studio/seed.ts', 'studio/content/docs/', 'examples/', 'infra/local/sandbox/', 'infra/local/README.md'];

/** The most lines a change may add outside tests/. */
export const maxAddedLines = 300;

/** The most files outside tests/ a change may add to or change. */
export const maxFiles = 8;

/** Whether a file counts toward the caps: test files never do. */
export const capped = path => !path.startsWith('tests/');

const forbidden = [
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, 'an environment file must not change'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, 'key material must not change'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, 'an SSH key must not change'],
  [/(^|\/)\.(npmrc|netrc|git-credentials|pypirc)$/, 'a credentials file must not change'],
  [/(^|\/)\.github\/workflows\//, 'CI configuration must not change'],
  [/(^|\/)\.git(\/|$)/, 'git internals must not change'],
  [/(^|\/)AGENTS\.md$/, 'writes harness memory (AGENTS.md); propose a note instead'],
  [/(^|\/)CLAUDE(\.local)?\.md$/, 'writes harness memory (CLAUDE.md); propose a note instead'],
  [/(^|\/)\.opencode\//, 'writes harness memory (.opencode/); propose a note instead'],
];

const working = /(^|\/)(audit|report|review|findings|summary|notes?|todo|unclear|deferred|progress|status|plan)([-_.][^/]*)?\.md$/i;

/** Why safety.mjs fails a change to `path` by its name alone, by the same rules; `fresh` marks a file the change adds. */
export const rejects = (path, fresh) => [
  ...forbidden.filter(([pattern]) => pattern.test(path)).map(([, why]) => why),
  ...(fresh && working.test(path) ? ['a new report or tracking file; put the outcome where the project keeps its records'] : []),
];
