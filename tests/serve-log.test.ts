import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stamped } from '../src/serve.ts';
import { temp } from './kit.ts';

describe('stamped', () => {
  it('writes each line with its time to stderr and serve.log', () => {
    const dir = temp('serve-log');
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    stamped(dir)('ALERT x');
    const [written] = err.mock.calls[0]!;
    err.mockRestore();
    expect(readFileSync(join(dir, 'serve.log'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ALERT x\n$/);
    expect(String(written)).toContain('ALERT x');
  });
});
