import { describe, expect, it } from 'vitest';
import { githubApp } from '../src/github-app.ts';
import { serveGitHub } from '../src/serve-github.ts';
import { openStore } from '../src/store.ts';
import type { BotEvent } from '../src/types.ts';
import { replay } from '../src/webhook.ts';
import { temp } from './kit.ts';

const quiet = (lines: string[], gh: (method: string, path: string) => unknown = () => undefined) => ({
  data: temp('data'),
  app: {
    repoClient: () => (async (method: string, path: string) => gh(method, path)) as never,
    repoToken: async () => 't',
  },
  secret: 'test-secret',
  env: {},
  port: 0,
  webhookPort: 0,
  log: (line: string) => lines.push(line),
});

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

  it('marks runs a stopped process left unfinished as interrupted and runs their event again', async () => {
    const lines: string[] = [];
    const options = quiet(lines);
    const event: BotEvent = {
      id: 'd1',
      ts: '2026-10-12T00:00:00.000Z',
      source: 'github',
      trigger: 'issue_comment',
      action: 'created',
      repo: 'acme/app',
      number: 1,
      actor: { login: 'morgan', association: 'OWNER' },
      body: '/bothub why',
    };
    const gone = openStore(options.data, { pid: 2 ** 22 + 1, token: 'gone' });
    const stale = await gone.create({ workflow: 'issue', job: 'answer', event });
    await gone.update(stale.id, { status: 'running', startedAt: event.ts });
    const served = await serveGitHub({ hub: temp('hub'), ...options });
    try {
      await served.idle();
      expect((await openStore(options.data).read(stale.id))?.status).toBe('interrupted');
      expect(lines).toContain('event issue_comment (created) on acme/app#1 by @morgan: 0 jobs');
    } finally {
      await served.stop();
    }
  });

  it('drops a labeled delivery whose label was removed before it ran', async () => {
    const lines: string[] = [];
    const issue = {
      number: 4,
      title: 't',
      state: 'open',
      body: '',
      html_url: 'u',
      labels: [],
      author_association: 'OWNER',
    };
    const options = quiet(lines, (_, path) => {
      if (path === '/repos/acme/app/issues/4') return issue;
      if (path.startsWith('/repos/acme/app/issues/4/comments')) return [];
      throw Object.assign(new Error('not found'), { status: 404 });
    });
    const served = await serveGitHub({ hub: temp('hub'), ...options });
    try {
      const payload = {
        action: 'labeled',
        repository: { full_name: 'acme/app' },
        sender: { login: 'morgan' },
        label: { name: 'bot:helper' },
        issue: { ...issue, user: { login: 'morgan' } },
      };
      const sent = await replay({
        url: `http://127.0.0.1:${served.ports.webhook}/`,
        secret: 'test-secret',
        event: 'issues',
        payload: JSON.stringify(payload),
        deliveryId: 'd1',
      });
      expect(sent.status).toBe(202);
      await served.idle();
      expect(lines).toContain('event d1 dropped, its label "bot:helper" was removed');
      expect(lines.some(line => line.startsWith('event issues'))).toBe(false);
    } finally {
      await served.stop();
    }
  });
});
