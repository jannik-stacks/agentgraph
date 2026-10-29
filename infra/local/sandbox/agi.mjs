import { runFile } from './file.ts';

try {
  const [verb, ...args] = process.argv.slice(2);
  if (verb !== 'file') throw new Error('usage: agi file put <path>');
  console.log(await runFile(args));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
