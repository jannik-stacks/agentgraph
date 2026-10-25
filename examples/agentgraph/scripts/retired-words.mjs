export const retiredWords = [
  ['bothub', 'agentgraph'],
  ['compound', 'what it does'],
  ['climb', 'what it does'],
  ['stamp', 'RunLink'],
  ['provenance', 'RunLink'],
  ['core', 'the engine'],
  ['alive', 'running'],
  ['executor', 'harness', /\bexecutors?\b/i],
  ['soul', 'agent', /\bsouls?\b/i],
  ['persona', 'agent', /\bpersonas?\b/i],
  ['open-pr', 'pull_request', /\bopen-pr\b/],
  ['for-each', '`each:`', /\bfor-each\b|\bforEach:/],
  ['`can:`', '`returns:`', /^\s*can:/],
  ['extra prompt', 'prompt', /\bextra[ -]prompt\b/i],
  ['a convention or pattern note kind', 'notes/style', /\bnotes\/(convention|pattern)s?\b/],
];

export const findRetiredWordInName = name => {
  const words = new Set(
    name.split(/(?<=[a-z\d])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[^A-Za-z]+/).map(word => word.toLowerCase())
  );
  return retiredWords.find(([word]) => words.has(word) || words.has(`${word}s`));
};
