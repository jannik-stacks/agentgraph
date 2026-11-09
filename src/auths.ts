import { createHash, timingSafeEqual } from 'node:crypto';
import { type AuthHost, type AuthRequest, type AuthResult, makePlugin } from './plugin.ts';

const loginPath = '/auth/login';

const hash = (text: string) => createHash('sha256').update(text).digest();

export const isSameSecret = (given: string, secret: string) => timingSafeEqual(hash(given), hash(secret));

const makeSecretCheck =
  (name: string, variable: string, inUrl: boolean) =>
  ({ env }: AuthHost) => {
    const secret = env[variable];
    if (!secret) throw new Error(`auth ${name} needs ${variable}`);
    return ({ url, form }: AuthRequest): AuthResult => {
      const given = form?.get('secret') ?? (inUrl && url.pathname === loginPath ? url.searchParams.get('token') : null);
      if (given === null) return { kind: 'login', url: loginPath };
      return isSameSecret(given, secret) ? { kind: 'user', user: name } : { kind: 'refuse', why: `wrong ${name}` };
    };
  };

export const none = makePlugin({ name: 'none', auth: () => () => ({ kind: 'user', user: 'anyone' }) });

export const token = makePlugin({ name: 'token', auth: makeSecretCheck('token', 'AGENTGRAPH_STUDIO_TOKEN', true) });

export const password = makePlugin({
  name: 'password',
  auth: makeSecretCheck('password', 'AGENTGRAPH_STUDIO_PASSWORD', false),
});
