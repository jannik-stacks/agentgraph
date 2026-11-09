import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ModalClient } from '../../examples/plugins/modal/modal.ts';

type Created = Parameters<ModalClient['sandboxes']['create']>[2];

export const makeFakeModal = (dir: string) => {
  const boxes: { root: string; params: Created; tags: Record<string, string>; terminated: boolean }[] = [];
  const children = new Set<ChildProcess>();
  const makeBox = (box: (typeof boxes)[number]) => ({
    exec: async (argv: string[], o: { env: Record<string, string> }) => {
      const [cmd = 'sh', ...args] = argv.map(arg =>
        arg.replace(/^(\w+=)(\/(homes|graph|news)(\/.*)?)$/s, `$1${box.root}$2`)
      );
      const child = spawn(cmd, args, {
        env: { ...process.env, ...o.env, AGENTGRAPH_BOX_ROOT: box.root },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      children.add(child);
      const closed = new Promise<number>(resolve =>
        child.on('close', code => {
          children.delete(child);
          resolve(code ?? 137);
        })
      );
      child.stdin.on('error', () => undefined);
      return {
        stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => closed,
      };
    },
    setTags: async (tags: Record<string, string>) => void (box.tags = tags),
    getTags: async () => box.tags,
    terminate: async () => {
      box.terminated = true;
      rmSync(box.root, { recursive: true, force: true });
    },
  });
  const client: ModalClient = {
    apps: { fromName: async name => ({ appId: name }) },
    images: { fromRegistry: ref => ref },
    sandboxes: {
      create: async (_app, _image, params) => {
        const box = { root: join(dir, String(boxes.length)), params, tags: {}, terminated: false };
        mkdirSync(join(box.root, 'tmp'), { recursive: true });
        boxes.push(box);
        return makeBox(box);
      },
      async *list({ tags }) {
        for (const box of boxes)
          if (!box.terminated && Object.entries(tags).every(([k, v]) => box.tags[k] === v)) yield makeBox(box);
      },
    },
  };
  const stop = () => {
    for (const child of children) process.kill(-child.pid!, 'SIGKILL');
  };
  return { client, boxes, stop };
};
