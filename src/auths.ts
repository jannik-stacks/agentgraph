import { createHash, timingSafeEqual } from 'node:crypto';
import { type AuthHost, type AuthRequest, type AuthResult, makePlugin } from './plugin.ts';

const hash = (text: string) => createHash('sha256').update(text).digest();

export const isSameSecret = (given: string, secret: string) => timingSafeEqual(hash(given), hash(secret));

const makeSecretCheck =
  (name: string, variable: string, inUrl: boolean) =>
  ({ env }: AuthHost) => {
    const secret = env[variable];
    if (!secret) throw new Error(`auth ${name} needs ${variable}`);
    return ({ url, form }: AuthRequest): AuthResult => {
      const given = form?.get('secret') ?? (inUrl ? url.searchParams.get('token') : null);
      if (given === null) return { login: '/auth/login' };
      return isSameSecret(given, secret) ? { user: name } : { refuse: `wrong ${name}` };
    };
  };

export const none = makePlugin({ name: 'none', auth: () => () => ({ user: 'anyone' }) });

export const token = makePlugin({ name: 'token', auth: makeSecretCheck('token', 'AGI_STUDIO_TOKEN', true) });

export const password = makePlugin({
  name: 'password',
  auth: makeSecretCheck('password', 'AGENTGRAPH_STUDIO_PASSWORD', false),
});
