
export const paths = ['src/', 'tests/', 'studio/src/', 'studio/seed.ts', 'docs/', 'examples/', 'infra/local/sandbox/', 'infra/local/README.md'];

export const maxAddedLines = 300;

export const maxFiles = 8;

export const capped = path => !path.startsWith('tests/') && !path.endsWith('package-lock.json');

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

export const findSafetyRejections = (path, fresh) => [
  ...forbidden.filter(([pattern]) => pattern.test(path)).map(([, why]) => why),
  ...(fresh && working.test(path) ? ['a new report or tracking file; put the outcome where the project keeps its records'] : []),
];
