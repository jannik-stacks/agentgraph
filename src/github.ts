import { z } from 'zod';
import { Association, type Trigger } from './schema.ts';
import type { BotEvent } from './types.ts';

const encoder = new TextEncoder();
const bytes = (body: string | Uint8Array) => (typeof body === 'string' ? encoder.encode(body) : body);

/** The `X-Hub-Signature-256` header value GitHub sends for `body`, an HMAC SHA-256 keyed with the webhook secret. */
export const sign = async (secret: string, body: string | Uint8Array): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(body) as Uint8Array<ArrayBuffer>));
  return 'sha256=' + Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
};

/** Checks a GitHub `X-Hub-Signature-256` header against the raw request body. Uses Web Crypto, so it runs on Node and Workers. */
export const verifySignature = async (
  secret: string,
  body: string | Uint8Array,
  header: string | null
): Promise<boolean> => {
  if (!secret || !header?.startsWith('sha256=')) return false;
  return timingSafeEqual(await sign(secret, body), header);
};

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const Associated = Association.catch('NONE');
const User = z.object({ login: z.string(), type: z.string().optional() });
const isBot = (user: z.infer<typeof User>) => user.type === 'Bot' || user.login.endsWith('[bot]');
const Repo = z.object({ full_name: z.string() });
const Item = z.object({ number: z.number(), html_url: z.string(), body: z.string().nullish(), user: User });

const Payload = z.object({
  action: z.string().optional(),
  repository: Repo,
  sender: User,
  comment: z.object({ body: z.string(), html_url: z.string(), author_association: Associated }).optional(),
  issue: Item.extend({ author_association: Associated, pull_request: z.object({}).nullish() }).optional(),
  pull_request: Item.extend({ author_association: Associated, base: z.object({ ref: z.string() }) }).optional(),
  review: z.object({ body: z.string().nullish(), html_url: z.string(), author_association: Associated }).optional(),
  ref: z.string().optional(),
  label: z.object({ name: z.string() }).optional(),
});

/** Webhook events `toEvent` maps; every other event name is ignored. */
export const handled: ReadonlySet<string> = new Set<string>([
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
 * pull request, including comments on it, carry its `refs/pull/<n>/head` ref, which also covers forks. The actor is
 * the sender; a bot sender is always `NONE`, so a label or close a bot makes never passes a trust guard.
 */
export const toEvent = (name: string, deliveryId: string, payload: unknown, now = new Date()): BotEvent | undefined => {
  if (!handled.has(name)) return;
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
    actor: { login: p.sender.login, association: isBot(p.sender) ? 'NONE' : (authored?.author_association ?? 'NONE') },
    ...(authored?.body != null && { body: authored.body }),
    ...(url && { url }),
    ...(ref && { ref }),
    ...(branch && { branch }),
    ...(p.label && { label: p.label.name }),
  };
};
