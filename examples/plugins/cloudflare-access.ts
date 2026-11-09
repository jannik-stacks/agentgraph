import { makePlugin } from '@jannik-stacks/agi/plugins';
import { Schema } from 'effect';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const settings = Schema.Struct({
  team: Schema.String,
  audience: Schema.String,
  domains: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});

export default makePlugin<typeof settings.Type>({
  name: 'cloudflare-access',
  settingsSchema: settings,
  auth: (_host, { team, audience, domains }) => {
    const keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', team));
    return async ({ headers }) => {
      const assertion = headers['cf-access-jwt-assertion'];
      if (typeof assertion !== 'string') return { refuse: 'open the studio through Cloudflare Access' };
      const verified = await jwtVerify(assertion, keys, { issuer: new URL(team).origin, audience }).catch(
        () => undefined
      );
      const email = verified?.payload.email;
      if (typeof email !== 'string') return { refuse: 'the Cloudflare Access token does not verify' };
      const domain = email.split('@').at(-1)!.toLowerCase();
      return domains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
        ? { user: email }
        : { refuse: `${email} is not on an allowed domain` };
    };
  },
});
