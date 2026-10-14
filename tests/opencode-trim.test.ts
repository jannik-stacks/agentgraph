import { describe, expect, it } from 'vitest';
import { limit, trim, trimmer } from '../src/harnesses/opencode-trim.ts';

describe('opencode trim', () => {
  it('passes short output unchanged', () => {
    expect(trim('a\nb')).toBe('a\nb');
  });

  it('cuts long output at a line end and says how to narrow the call', () => {
    const [kept, note] = trim(`${'x'.repeat(100)}\n`.repeat(200)).split('\n[bothub]');
    expect(kept!.length).toBeLessThanOrEqual(limit);
    expect(kept!.endsWith('\n')).toBe(true);
    expect(note).toContain('read with offset and limit');
  });

  it('trims read and grep results only', async () => {
    process.env.HOME = process.env.TMPDIR ?? '/tmp';
    const hook = (await trimmer())['tool.execute.after'];
    const big = 'y'.repeat(limit * 2);
    const [read, grep, bash] = [{ output: big }, { output: big }, { output: big }];
    await hook({ tool: 'read' }, read);
    await hook({ tool: 'grep' }, grep);
    await hook({ tool: 'bash' }, bash);
    expect(read.output.length).toBeLessThan(limit + 200);
    expect(grep.output.length).toBeLessThan(limit + 200);
    expect(bash.output).toBe(big);
  });
});
