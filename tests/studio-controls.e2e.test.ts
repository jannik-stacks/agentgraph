import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchRow } from '../examples/plugins/bench/plugins/bench/data.ts';
import { tmp } from './kit.ts';
import { createStudioServer } from './studio.ts';

const chrome = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(path => existsSync(path));

const startBrowser = async () => {
  const profile = tmp('chrome');
  const child = spawn(
    chrome!,
    [
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const ended = once(child, 'exit');
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    const port = await vi.waitFor(
      () => {
        const port = readFileSync(portFile, 'utf8').split('\n')[0];
        expect(port).toMatch(/^\d+$/);
        return port;
      },
      { timeout: 15_000 }
    );
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const socket = new WebSocket(pages.find(page => page.type === 'page')!.webSocketDebuggerUrl);
    await once(socket, 'open');
    let id = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const reply = pending.get(message.id);
      if (!reply) return;
      pending.delete(message.id);
      if (message.error) reply.reject(new Error(message.error.message));
      else reply.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const reply of pending.values()) reply.reject(new Error('Chrome connection closed'));
      pending.clear();
    });
    const send = <T = unknown>(method: string, params: object = {}) =>
      new Promise<T>((resolve, reject) => {
        pending.set(++id, { resolve: value => resolve(value as T), reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async <T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<Awaited<T>> => {
      const result = await send<{
        exceptionDetails?: { exception: { description: string } };
        result: { value: Awaited<T> };
      }>('Runtime.evaluate', {
        expression: `(${run.toString()})(${JSON.stringify(arg)})`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception.description);
      return result.result.value;
    };
    return {
      send,
      evaluate,
      async close() {
        await send('Browser.close').catch(() => {});
        await ended;
        socket.close();
        rmSync(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    child.kill();
    await ended;
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
};

const row = (model: string, harness: string, over: Partial<BenchRow> = {}): BenchRow => ({
  labels: { model, harness, arm: 'v2', set: 'test', tests: 'hidden' },
  case: 'task',
  repeat: 1,
  vsHuman: {},
  findings: { critical: 0, high: 0 },
  answers: 0,
  minutes: 1,
  tokens: {},
  split: { agent: 0, tools: 0, setup: 0, checks: 0, infra: 0 },
  usd: 1,
  usdUncached: 1,
  checkUsd: 0,
  hidden: 1,
  run: `${model}-${harness}`,
  data: '/bench/data',
  at: '',
  results: {},
  ...over,
});

const initialRows = [
  row('smart', 'codex'),
  row('small', 'codex'),
  row('smart', 'opencode'),
  row('small', 'opencode', { run: 'failed', infra: 'SandboxError: unavailable' }),
  row('smart', 'codex', { labels: { model: 'smart', harness: 'codex', arm: 'human' }, infra: 'reference failure' }),
];

describe.skipIf(!chrome)(`bench controls in Chrome${chrome ? '' : ' (Chrome/Chromium not installed)'}`, () => {
  let browser: Awaited<ReturnType<typeof startBrowser>>;
  let server: Awaited<ReturnType<typeof createStudioServer>>;
  let base: string;
  let root: string;
  let rows = initialRows;

  beforeAll(async () => {
    root = tmp('bench-controls');
    vi.stubEnv('AGI_STUDIO_DIR', undefined);
    vi.stubEnv('AGI_STUDIO_DATA', root);
    vi.stubEnv('AGI_STUDIO_PLUGINS', join(import.meta.dirname, '../examples/plugins/bench'));
    server = await createStudioServer(['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']);
    server.middlewares.stack.unshift({
      route: '/api/plugins/bench/data',
      handle: (_req: unknown, res: ServerResponse) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ rows, fields: [], conflicts: [] }));
      },
    });
    await server.listen();
    base = server.resolvedUrls.local[0].replace(/\/$/, '');
    browser = await startBrowser();
    await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }, 30_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await server?.close();
      vi.unstubAllEnvs();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  const open = async (label: string) => {
    await browser.evaluate(label => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('aside button[popovertarget]')].find(
        button => document.getElementById(button.getAttribute('aria-labelledby')!.split(' ')[0]!)?.textContent === label
      )!;
      button.scrollIntoView();
      button.click();
    }, label);
    await vi.waitFor(async () =>
      expect(await browser.evaluate(() => !!document.querySelector('[role="dialog"]:popover-open'))).toBe(true)
    );
  };
  const click = async (text: string) => {
    await browser.evaluate(
      text =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"]:popover-open button')]
          .find(button => button.getAttribute('aria-label') === text || button.textContent === text)!
          .click(),
      text
    );
  };
  const picks = () =>
    browser.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLInputElement>('[role="dialog"]:popover-open input[type="checkbox"]:checked'),
      ].map(input => input.parentElement!.textContent!.trim())
    );
  const query = (key: string) => browser.evaluate(key => new URL(location.href).searchParams.get(key), key);
  const escape = async () => {
    await browser.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await browser.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await vi.waitFor(async () =>
      expect(
        await browser.evaluate(() => ({
          isOpen: !!document.querySelector('[role="dialog"]:popover-open'),
          isExpanded: !!document.querySelector('button[popovertarget][aria-expanded="true"]'),
        }))
      ).toEqual({ isOpen: false, isExpanded: false })
    );
  };
  const load = async (query = '') => {
    await browser.send('Page.navigate', { url: `${base}/plugins/bench${query}` });
    await vi.waitFor(
      async () =>
        expect(await browser.evaluate(() => document.querySelector('aside h3 [aria-describedby]')?.textContent)).toBe(
          'Weights'
        ),
      { timeout: 15_000 }
    );
  };
  const toggle = (value: string) =>
    browser.evaluate(
      value =>
        [...document.querySelectorAll<HTMLInputElement>('[role="dialog"]:popover-open input[type="checkbox"]')]
          .find(input => input.parentElement!.textContent!.trim() === value)!
          .click(),
      value
    );
  const pointCount = () =>
    browser.evaluate(() => document.querySelectorAll('main table > tbody > tr.cursor-pointer').length);
  const countInfra = () =>
    browser.evaluate(
      () =>
        [...document.querySelectorAll('aside p')].find(p => p.textContent?.includes('infra runs match filters'))
          ?.textContent
    );

  beforeEach(async () => {
    rows = initialRows;
    await load();
  }, 30_000);

  it('uses dotted labels with keyboard-accessible help and a Group by heading', async () => {
    expect(
      await browser.evaluate(() => ({
        headings: [...document.querySelectorAll('aside h3')].map(
          heading => heading.querySelector('[aria-describedby]')?.textContent
        ),
        isHelpIconShown: [...document.querySelectorAll('aside span')].some(span => span.textContent?.trim() === '?'),
      }))
    ).toEqual({
      headings: ['Weights', 'Axis', 'Filter', 'Group by', 'Infra', 'Excluded', 'Judges'],
      isHelpIconShown: false,
    });
    await browser.evaluate(() => document.querySelector<HTMLElement>('aside h3 [tabindex="0"]')!.focus());
    await vi.waitFor(async () =>
      expect(await browser.evaluate(() => document.querySelector('[role="tooltip"]:popover-open')?.textContent)).toBe(
        'Choose a preset or adjust how much each score and penalty counts.'
      )
    );
    expect(
      await browser.evaluate(() => ({
        decoration: getComputedStyle(document.activeElement!).textDecorationStyle,
        heading: getComputedStyle(document.querySelector('aside h3')!).textTransform,
        tooltip: getComputedStyle(document.querySelector('[role="tooltip"]:popover-open')!).textTransform,
      }))
    ).toEqual({ decoration: 'dotted', heading: 'uppercase', tooltip: 'none' });
    await browser.evaluate(() => document.querySelector<HTMLElement>('label[for="w-test"]')!.focus());
    await vi.waitFor(async () =>
      expect(
        await browser.evaluate(() => document.querySelector('[role="tooltip"]:popover-open')?.textContent)
      ).toContain('Test files added by the merged pull request')
    );
  });

  it('keeps filters on one row with short summaries and an unscaled dropdown', async () => {
    expect(
      await browser.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('aside button[popovertarget]')].map(button => {
          const label = document.getElementById(button.getAttribute('aria-labelledby')!.split(' ')[0]!)!;
          const text = document.getElementById(button.getAttribute('aria-labelledby')!.split(' ')[1]!)!;
          const a = label.getBoundingClientRect();
          const b = button.getBoundingClientRect();
          return {
            label: label.textContent,
            summary: text.textContent,
            isSameRow: a.top < b.bottom && b.top < a.bottom && a.right <= b.left,
            chevron: button.querySelector('svg path')?.getAttribute('d'),
          };
        })
      )
    ).toEqual([
      { label: 'arm', summary: 'human, v2', isSameRow: true, chevron: 'm6 9 6 6 6-6' },
      { label: 'harness', summary: 'codex, opencode', isSameRow: true, chevron: 'm6 9 6 6 6-6' },
      { label: 'model', summary: 'small, smart', isSameRow: true, chevron: 'm6 9 6 6 6-6' },
      { label: 'Labels', summary: 'arm, harness, model, set', isSameRow: true, chevron: 'm6 9 6 6 6-6' },
    ]);
    await open('model');
    expect(
      await browser.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]:popover-open')!;
        const style = getComputedStyle(panel);
        return { transform: style.transform, scale: style.scale, transition: style.transitionProperty };
      })
    ).toEqual({ transform: 'none', scale: 'none', transition: 'opacity, overlay, display' });
    await click('Select only smart for model');
    await escape();
    expect(await browser.evaluate(() => document.activeElement?.querySelector('span')?.textContent)).toBe('smart');
  });

  it('aligns the color label and control with the Group by labels row', async () => {
    expect(
      await browser.evaluate(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('aside button[popovertarget]')].find(
          button =>
            document.getElementById(button.getAttribute('aria-labelledby')!.split(' ')[0]!)?.textContent === 'Labels'
        )!;
        const label = document.getElementById(button.getAttribute('aria-labelledby')!.split(' ')[0]!)!;
        const select = [...document.querySelectorAll<HTMLSelectElement>('aside select')].find(select =>
          select.closest('label')?.textContent?.startsWith('color')
        )!;
        const range = document.createRange();
        range.selectNodeContents(select.closest('label')!.firstChild!);
        return {
          isLabelAligned: Math.abs(range.getBoundingClientRect().left - label.getBoundingClientRect().left) < 1,
          isControlAligned: Math.abs(select.getBoundingClientRect().left - button.getBoundingClientRect().left) < 1,
          isWidthAligned: Math.abs(select.getBoundingClientRect().width - button.getBoundingClientRect().width) < 1,
        };
      })
    ).toEqual({ isLabelAligned: true, isControlAligned: true, isWidthAligned: true });
  });

  it('keeps the sidebar scroll fade when compact controls overflow', async () => {
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 500,
      deviceScaleFactor: 1,
      mobile: false,
    });
    try {
      await vi.waitFor(async () =>
        expect(
          await browser.evaluate(() => {
            const aside = document.querySelector('aside')!;
            return {
              isOverflowing: aside.scrollHeight > aside.clientHeight,
              isFaded: getComputedStyle(aside).maskImage !== 'none',
            };
          })
        ).toEqual({ isOverflowing: true, isFaded: true })
      );
    } finally {
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: 1400,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
  });

  it('still searches choices and reports no matches', async () => {
    await open('model');
    await browser.send('Input.insertText', { text: 'SMART' });
    expect(await picks()).toEqual(['smart']);
    await browser.send('Input.insertText', { text: '-missing' });
    expect(await browser.evaluate(() => document.querySelector('[role="dialog"]:popover-open')!.textContent)).toContain(
      'No matches.'
    );
  });

  it('cleans stale saved picks before checking a current Filter value', async () => {
    await load(`?where=${encodeURIComponent(JSON.stringify({ model: ['retired'] }))}`);
    await open('model');
    await toggle('smart');
    await vi.waitFor(async () => expect(JSON.parse((await query('where'))!)).toEqual({ model: ['smart'] }));
    expect(await picks()).toEqual(['smart']);
  });

  it('still updates checkboxes and all/none in Filter, including no matching runs', async () => {
    await open('model');
    await toggle('small');
    await vi.waitFor(async () => expect(JSON.parse((await query('where'))!)).toEqual({ model: ['smart'] }));
    expect(await picks()).toEqual(['smart']);
    await click('none');
    await vi.waitFor(async () => expect(JSON.parse((await query('where'))!)).toEqual({ model: [] }));
    expect(await picks()).toEqual([]);
    expect(await pointCount()).toBe(0);
    expect(await countInfra()).toBe('0 of 1 infra runs match filters');
    await click('all');
    await vi.waitFor(async () => expect(await query('where')).toBeNull());
    expect(await picks()).toEqual(['small', 'smart']);
    expect(await pointCount()).toBe(3);
  });

  it('still selects only one Filter value while preserving filters on other labels', async () => {
    await load(`?where=${encodeURIComponent(JSON.stringify({ harness: ['codex'] }))}`);
    await open('model');
    await click('Select only small for model');
    await vi.waitFor(async () =>
      expect(JSON.parse((await query('where'))!)).toEqual({ harness: ['codex'], model: ['small'] })
    );
    expect(await picks()).toEqual(['small']);
    expect(await pointCount()).toBe(1);
  });

  it('still wires Group by checkboxes, all/none and only, including an empty grouping', async () => {
    await browser.evaluate(() => {
      const select = [...document.querySelectorAll<HTMLSelectElement>('aside select')].find(select =>
        select.parentElement?.parentElement?.textContent?.startsWith('color')
      )!;
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await open('Labels');
    await click('Select only model for Labels');
    await vi.waitFor(async () => expect(await query('by')).toBe('model'));
    expect(await picks()).toEqual(['model']);
    expect(await pointCount()).toBe(2);
    await toggle('harness');
    await vi.waitFor(async () => expect((await query('by'))?.split(',').toSorted()).toEqual(['harness', 'model']));
    expect(await pointCount()).toBe(3);
    await click('none');
    await vi.waitFor(async () => expect(await query('by')).toBe(''));
    expect(await picks()).toEqual([]);
    expect(await pointCount()).toBe(1);
    await click('all');
    await vi.waitFor(async () =>
      expect((await query('by'))?.split(',')).toEqual(['arm', 'harness', 'model', 'set', 'tests'])
    );
    expect(await picks()).toEqual(['arm', 'harness', 'model', 'set', 'tests']);
    expect(await pointCount()).toBe(3);
  });

  it('cleans stale Group-by keys before adding a current label', async () => {
    await load('?by=retired&color=');
    await open('Labels');
    await toggle('model');
    await vi.waitFor(async () => expect(await query('by')).toBe('model'));
    expect(await picks()).toEqual(['model']);
    expect(await pointCount()).toBe(2);
  });

  it('still focuses search on open and returns focus to the trigger on Escape', async () => {
    await open('model');
    expect(await browser.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Search model');
    await escape();
    expect(await browser.evaluate(() => document.activeElement?.getAttribute('popovertarget'))).toBeTruthy();
    expect(await browser.evaluate(() => document.activeElement?.textContent)).toContain('small, smart');
  });

  it('still dismisses the panel on a real outside click', async () => {
    await open('model');
    const point = await browser.evaluate(() => {
      const rect = document.querySelector('main')!.getBoundingClientRect();
      return { x: rect.right - 20, y: rect.top + 20 };
    });
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await vi.waitFor(async () =>
      expect(await browser.evaluate(() => document.querySelector('[role="dialog"]:popover-open'))).toBeNull()
    );
  });

  it('cleans selections after live data removes a value', async () => {
    await load(`?where=${encodeURIComponent(JSON.stringify({ model: ['smart'] }))}`);
    rows = [row('small', 'codex'), row('new', 'codex')];
    server.ws.send('agi:changed', { topics: ['bench'] });
    await open('model');
    await vi.waitFor(async () =>
      expect(
        await browser.evaluate(() =>
          [...document.querySelectorAll('[role="dialog"]:popover-open label')].map(label => label.textContent!.trim())
        )
      ).toEqual(['new', 'small'])
    );
    expect(await picks()).toEqual([]);
    await toggle('small');
    await vi.waitFor(async () => expect(JSON.parse((await query('where'))!)).toEqual({ model: ['small'] }));
    expect(await picks()).toEqual(['small']);
  });

  it('still removes the fade when search shrinks an overflowing checkbox list', async () => {
    rows = Array.from({ length: 34 }, (_, i) => row(`model-${String(i).padStart(2, '0')}`, 'codex'));
    await load();
    await open('model');
    const fade = () =>
      browser.evaluate(() => {
        const list = document
          .querySelector('[role="dialog"]:popover-open input[type="checkbox"]')!
          .closest('div')!.parentElement!;
        return {
          isOverflowing: list.scrollHeight > list.clientHeight,
          isFaded: getComputedStyle(list).maskImage !== 'none',
        };
      });
    await vi.waitFor(async () => expect(await fade()).toEqual({ isOverflowing: true, isFaded: true }));
    await browser.send('Input.insertText', { text: 'model-01' });
    await vi.waitFor(async () => expect(await fade()).toEqual({ isOverflowing: false, isFaded: false }));
    await escape();
    await open('model');
    await vi.waitFor(async () => expect(await fade()).toEqual({ isOverflowing: true, isFaded: true }));
  });

  it('still shows Infra counts, reasons and links without counting failures as zero', async () => {
    expect(await countInfra()).toBe('1 of 1 infra runs match filters');
    expect(await pointCount()).toBe(3);
    await browser.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('aside summary')]
        .find(summary => summary.textContent?.includes('Inspect infra runs'))!
        .click()
    );
    await vi.waitFor(async () =>
      expect(await browser.evaluate(() => document.querySelector('aside li p')?.textContent)).toBe(
        'SandboxError: unavailable'
      )
    );
    expect(await browser.evaluate(() => document.querySelector('aside li a')?.getAttribute('href'))).toBe(
      '/runs/failed?data=%2Fbench%2Fdata'
    );
    await browser.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('aside input[type="checkbox"]')]
        .find(input => input.parentElement?.textContent?.includes('Count infra runs as 0'))!
        .click()
    );
    await vi.waitFor(async () => expect(await pointCount()).toBe(4));
    expect(await countInfra()).toBe('1 of 1 infra runs match filters');
    expect(await browser.evaluate(() => document.querySelector('aside li p')?.textContent)).toBe(
      'SandboxError: unavailable'
    );
    await open('model');
    await click('Select only smart for model');
    await vi.waitFor(async () => expect(await countInfra()).toBe('0 of 1 infra runs match filters'));
    expect(await browser.evaluate(() => document.querySelectorAll('aside li').length)).toBe(0);
  });
});
