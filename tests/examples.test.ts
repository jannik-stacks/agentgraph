import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Effect } from 'effect';
import { loadHub } from '../src/hub.ts';

const examples = join(import.meta.dirname, '..', 'examples');
const infra = join(import.meta.dirname, '..', 'infra', 'local');
const hubDirs = readdirSync(examples)
  .map(name => join(examples, name))
  .filter(dir => existsSync(join(dir, 'hub.yaml')));
const agentsOf = async (dir: string) => Object.values((await Effect.runPromise(loadHub(dir))).agents);

describe('example hubs', () => {
  it('finds every example hub', () => {
    expect(hubDirs.map(dir => dir.slice(examples.length + 1))).toEqual(
      expect.arrayContaining(['bothub', 'clarinet', 'sandbox', 'sk', 'acme-app'])
    );
  });

  it.each(hubDirs)('%s loads with no problems', async dir => {
    await expect(Effect.runPromise(loadHub(dir))).resolves.toMatchObject({ workflows: expect.any(Object) });
  });
});

/** Rows of the BOTS table in keys.sh: bot name and the model aliases its key may call. */
const keyRows = () => {
  const text = readFileSync(join(infra, 'keys.sh'), 'utf8');
  const table = /^BOTS=\(\n([\s\S]*?)^\)/m.exec(text)?.[1] ?? '';
  return new Map(
    [...table.matchAll(/^\s*"(\S+)\s+(\S+)\s+\d+\s+\d+\s+\d+\s*"/gm)].map(m => [m[1]!, m[2]!.split(',')] as const)
  );
};

const modelNames = (file: string) =>
  new Set(
    (parse(readFileSync(join(infra, file), 'utf8')) as { model_list: { model_name: string }[] }).model_list.map(
      m => m.model_name
    )
  );

describe('models and keys', () => {
  const served = modelNames('litellm.config.yaml');
  const rows = keyRows();

  it('reads the keys table and the model list', () => {
    expect(rows.size).toBeGreaterThan(0);
    expect(served.size).toBeGreaterThan(0);
  });

  it.each(hubDirs)('every agent in %s asks for a model alias LiteLLM serves', async dir => {
    const unknown = (await agentsOf(dir)).flatMap(a =>
      a.model && !served.has(a.model) ? [`${a.name}: ${a.model}`] : []
    );
    expect(unknown).toEqual([]);
  });

  it('gives every acme-app agent a key that allows its model', async () => {
    const problems = (await agentsOf(join(examples, 'acme-app'))).flatMap(bot => {
      const allowed = rows.get(bot.name);
      if (!allowed) return [`${bot.name} has no row in keys.sh`];
      if (bot.model && !allowed.includes(bot.model))
        return [`${bot.name} asks for ${bot.model}, its key allows ${allowed.join(',')}`];
      return [];
    });
    expect(problems).toEqual([]);
  });

  it('lets keys and fallbacks name only aliases both LiteLLM configs serve', () => {
    const config = parse(readFileSync(join(infra, 'litellm.config.yaml'), 'utf8')) as {
      litellm_settings?: { fallbacks?: Record<string, string[]>[] };
    };
    const fallbacks = (config.litellm_settings?.fallbacks ?? []).flatMap(f =>
      Object.entries(f).flatMap(([from, to]) => [from, ...to])
    );
    const offline = modelNames('litellm.offline.yaml');
    const named = new Set([...[...rows.values()].flat(), ...fallbacks, ...served]);
    const missing = [...named].flatMap(alias => [
      ...(served.has(alias) ? [] : [`${alias} is not in litellm.config.yaml`]),
      ...(offline.has(alias) ? [] : [`${alias} is not in litellm.offline.yaml`]),
    ]);
    expect(missing).toEqual([]);
  });
});
