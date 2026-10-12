import { describe, expect, it } from 'vitest';
import { githubApp } from '../src/github-app.ts';
import { serveGitHub } from '../src/serve-github.ts';
import { replay } from '../src/webhook.ts';
import { temp } from './git.ts';

describe('serveGitHub', () => {
  it('receives signed deliveries over HTTP and plans each delivery id once', async () => {
    const lines: string[] = [];
    const app = githubApp(
      { appId: 1, privateKey: 'unused' },
      {
        fetch: async () => {
          throw new Error('no GitHub calls expected');
        },
      }
    );
    const served = await serveGitHub({
      hub: temp('hub'),
      data: temp('data'),
      app,
      secret: 'test-secret',
      env: {},
      repos: ['acme/app'],
      port: 0,
      webhookPort: 0,
      log: line => lines.push(line),
    });
    try {
      const url = `http://127.0.0.1:${served.ports.webhook}/`;
      const send = (repo: string, deliveryId: string) =>
        replay({
          url,
          secret: 'test-secret',
          event: 'push',
          payload: JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: repo }, sender: { login: 'x' } }),
          deliveryId,
        });
      expect((await send('acme/app', 'd1')).status).toBe(202);
      expect((await send('acme/app', 'd1')).status).toBe(200);
      expect((await send('other/repo', 'd2')).status).toBe(202);
      await served.idle();
      expect(lines.filter(l => l.startsWith('event push'))).toEqual(['event push on acme/app by @x: 0 jobs']);
      expect(lines).toContain('event d2 from other/repo ignored');
    } finally {
      await served.stop();
    }
  });
});
