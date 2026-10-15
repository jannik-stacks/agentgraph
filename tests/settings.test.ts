import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../src/settings.ts';

afterEach(() => vi.unstubAllEnvs());

describe('settings', () => {
  it('reads the data path and address from the environment, with local defaults', () => {
    for (const name of ['BOTHUB_DATA', 'BOTHUB_LISTEN', 'BOTHUB_PORT', 'BOTHUB_URL']) vi.stubEnv(name, undefined);
    expect(settings()).toEqual({
      data: join(homedir(), '.bothub'),
      listen: '127.0.0.1',
      port: 5181,
      url: 'http://127.0.0.1:5181',
    });
    vi.stubEnv('BOTHUB_DATA', '/data');
    vi.stubEnv('BOTHUB_LISTEN', '0.0.0.0');
    vi.stubEnv('BOTHUB_PORT', '8080');
    expect(settings()).toMatchObject({ data: '/data', listen: '0.0.0.0', port: 8080 });
    vi.stubEnv('BOTHUB_PORT', 'eighty');
    expect(() => settings()).toThrow(/BOTHUB_PORT/);
  });
});
