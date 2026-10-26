export const retiredWords: { word: string; example?: string; text?: RegExp }[] = [
  { word: 'bothub', example: 'agentgraph' },
  { word: 'compound', example: 'what it does' },
  { word: 'climb', example: 'what it does' },
  { word: 'stamp', example: 'RunLink' },
  { word: 'provenance', example: 'RunLink' },
  { word: 'core', example: 'the engine' },
  { word: 'alive', example: 'running' },
  { word: 'executor', example: 'harness', text: /\bexecutors?\b/i },
  { word: 'soul', example: 'agent', text: /\bsouls?\b/i },
  { word: 'persona', example: 'agent', text: /\bpersonas?\b/i },
  { word: 'open-pr', example: 'pull_request', text: /\bopen-pr\b/ },
  { word: 'merge request', example: 'pull request', text: /\bmerge requests?\b/i },
  { word: '/agentgraph', example: '/agent followed by what you want', text: /(?<![\w./-])\/agentgraph\b(?![/-])/i },
  { word: 'bots/', example: 'agents/', text: /\bbots\// },
  { word: 'for-each', example: '`each:`', text: /\bfor-each\b|\bforEach:/ },
  { word: '`over:`', example: '`each:`', text: /^\s*over:/m },
  { word: '`can:`', example: '`returns:`', text: /^\s*can:/m },
  { word: 'extra prompt', example: 'prompt', text: /\bextra[ -]prompt\b/i },
  { word: 'a per-hub run limit', example: 'limits in hub.yaml', text: /\bruns-per-day\b|\bmax-turns\b/ },
  { word: 'a convention or pattern note kind', example: 'notes/style', text: /\bnotes\/(convention|pattern)s?\b/ },
  { word: 'a removed feature', text: /## Resuming|main-worktree|\/hub\/scripts|criteria table|adds the Closes/ },
];

export const formatRetiredAdvice = ({ example }: Pick<(typeof retiredWords)[number], 'example'>) =>
  example === undefined ? 'the engine no longer has it' : `find a clearer word, for example ${example}`;
