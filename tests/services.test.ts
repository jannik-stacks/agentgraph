import { ConfigProvider, Effect, Either, Redacted } from 'effect';
import { expect, it } from 'vitest';
import { settings } from '../src/services.ts';

const read = (name: string) =>
  Effect.runPromise(
    Effect.either(settings).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ['AGENTGRAPH_REPO', 'owner/repository'],
            ['AGENTGRAPH_TRACKER', '/tracker'],
            ['AGENTGRAPH_SESSION_ENV', name],
            [name, 'private-value'],
          ])
        )
      )
    )
  );

it.each(['AGENTGRAPH_TOOL_SECRET', 'AGENTGRAPH_APP_KEY', 'GH_TOKEN', 'PLUGIN_PASSWORD', 'UNREVIEWED_VALUE'])(
  'refuses forwarding %s to sessions',
  async name => {
    const result = await read(name);
    expect(Either.isLeft(result)).toBe(true);
    expect(String(Either.getLeft(result))).toContain('may list only model login variables');
  }
);

it.each(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AGENTGRAPH_CHATGPT_AUTH', 'OPENCODE_AUTH_CONTENT'])(
  'still forwards model authentication through %s',
  async name => {
    const result = await read(name);
    expect(Either.isRight(result)).toBe(true);
    expect(Redacted.value(Either.getOrThrow(result).passed[name]!)).toBe('private-value');
  }
);
