const byExtension: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonl: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shellscript',
  css: 'css',
  html: 'html',
  py: 'python',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  service: 'ini',
  timer: 'ini',
  socket: 'ini',
};

/** Every shiki language `langOf` can return, besides `text`. */
export const languages = [...new Set([...Object.values(byExtension), 'dockerfile', 'dotenv'])];

/** The shiki language for a file path, or `text`. */
export const langOf = (path: string) => {
  const name = path.split('/').pop() ?? path;
  if (name === 'Dockerfile') return 'dockerfile';
  if (name.startsWith('.env')) return 'dotenv';
  return byExtension[/\.(\w+)$/.exec(name)?.[1] ?? ''] ?? 'text';
};
