import { z } from 'zod';
import { Association, type Trigger } from './schema.ts';
import type { BotEvent } from './types.ts';

const encoder = new TextEncoder();

/** Checks a GitHub `X-Hub-Signature-256` header against the raw request body. Uses Web Crypto, so it runs on Node and Workers. */
export const verifySignature = async (secret: string, body: string, header: string | null): Promise<boolean> => {
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  const expected = 'sha256=' + Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, header);
};

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const User = z.object({ login: z.string() });
const Repo = z.object({ full_name: z.string() });
const Item = z.object({ number: z.number(), html_url: z.string(), body: z.string().nullish(), user: User });

const Payload = z.object({
  action: z.string().optional(),
  repository: Repo,
  sender: User,
  comment: z.object({ body: z.string(), html_url: z.string(), author_association: Association }).optional(),
  issue: Item.extend({ author_association: Association, pull_request: z.object({}).nullish() }).optional(),
  pull_request: Item.extend({ author_association: Association, base: z.object({ ref: z.string() }) }).optional(),
  review: z.object({ body: z.string().nullish(), html_url: z.string(), author_association: Association }).optional(),
  ref: z.string().optional(),
});

const mapped = new Set<string>([
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'workflow_dispatch',
]);

/**
 * Normalises a webhook delivery into a `BotEvent`, or `undefined` for events bothub does not handle. Events on a
 * pull request, including comments on it, carry its `refs/pull/<n>/head` ref, which also covers forks.
 */
export const toEvent = (name: string, deliveryId: string, payload: unknown, now = new Date()): BotEvent | undefined => {
  if (!mapped.has(name)) return;
  const p = Payload.parse(payload);
  const item = p.pull_request ?? p.issue;
  const authored = p.comment ?? p.review ?? item;
  const url = authored?.html_url ?? item?.html_url;
  const pr = p.pull_request ?? (p.issue?.pull_request ? p.issue : undefined);
  const ref = pr ? `refs/pull/${pr.number}/head` : p.ref;
  const branch = p.pull_request?.base.ref ?? p.ref?.match(/^refs\/heads\/(.+)$/)?.[1];
  return {
    id: deliveryId,
    ts: now.toISOString(),
    source: 'github',
    trigger: name as Trigger,
    ...(p.action && { action: p.action }),
    repo: p.repository.full_name,
    ...(item && { number: item.number }),
    actor: { login: p.sender.login, association: authored?.author_association ?? 'NONE' },
    ...(authored?.body != null && { body: authored.body }),
    ...(url && { url }),
    ...(ref && { ref }),
    ...(branch && { branch }),
  };
};
