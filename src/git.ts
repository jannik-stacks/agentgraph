import { execFile } from 'node:child_process';

const bot = { name: 'bothub[bot]', email: 'bothub[bot]@users.noreply.github.com' };

/** Commits made on the host are authored and committed by the bot. */
export const botEnv = {
  GIT_AUTHOR_NAME: bot.name,
  GIT_AUTHOR_EMAIL: bot.email,
  GIT_COMMITTER_NAME: bot.name,
  GIT_COMMITTER_EMAIL: bot.email,
};

type Exit = { code: number; stdout: string; stderr: string };

const failure = (args: string[], detail: string) => new Error(`git ${args.join(' ')} failed: ${detail}`);

const exec = (dir: string, args: string[], env: Record<string, string>) =>
  new Promise<Exit>((resolve, reject) =>
    execFile(
      'git',
      ['-C', dir, ...args],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 16 << 20 },
      (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code === 'number') resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        else reject(failure(args, stderr.trim() || (error?.message ?? 'killed')));
      }
    )
  );

/**
 * Runs git in `dir` without a shell or a prompt and resolves to its trimmed output. `env` extends the process
 * environment and never appears in errors.
 *
 * @throws when git exits non-zero, with its stderr.
 */
export const git = async (dir: string, args: string[], env: Record<string, string> = {}) => {
  const exit = await exec(dir, args, env);
  if (exit.code) throw failure(args, exit.stderr || `exit ${exit.code}`);
  return exit.stdout;
};

/**
 * Like {@link git}, but exit code 1, git's "no" for questions such as `rev-parse --verify` or `merge-tree`, resolves
 * with its code instead of rejecting.
 */
export const gitStatus = async (dir: string, args: string[], env: Record<string, string> = {}) => {
  const exit = await exec(dir, args, env);
  if (exit.code > 1) throw failure(args, exit.stderr || `exit ${exit.code}`);
  return exit;
};
