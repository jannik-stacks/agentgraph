import { Schema } from 'effect';

export type ResultType = {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  readonly properties?: Readonly<Record<string, ResultType>>;
  readonly required?: readonly string[];
  readonly items?: ResultType;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
};

const nested = Schema.suspend((): Schema.Schema<ResultType> => ResultType);
const optional = <S extends Schema.Schema.Any>(s: S) => Schema.optionalWith(s, { exact: true });

export const ResultType: Schema.Schema<ResultType> = Schema.Struct({
  type: optional(Schema.Literal('object', 'array', 'string', 'number', 'integer', 'boolean')),
  properties: optional(Schema.Record({ key: Schema.String, value: nested })),
  required: optional(Schema.Array(Schema.String)),
  items: optional(nested),
  enum: optional(Schema.Array(Schema.Unknown)),
  const: optional(Schema.Unknown),
  minimum: optional(Schema.Number),
  maximum: optional(Schema.Number),
  description: optional(Schema.String),
});

export type Result = Record<string, unknown>;

export const defaultReturns: ResultType = {
  type: 'object',
  required: ['pass'],
  properties: {
    pass: { type: 'boolean', description: 'true when the check passes, false when it fails' },
    why: {
      type: 'string',
      description: 'your findings: what you checked and, when it fails, what is wrong, where, and the smallest fix',
    },
  },
};

export const defaultPass: ResultType = { required: ['pass'], properties: { pass: { const: true } } };

export const whyPassUndecided = (returns: ResultType, pass: ResultType, at = 'result'): string | undefined => {
  const numeric = returns.type === 'number' || returns.type === 'integer';
  if ((pass.minimum !== undefined || pass.maximum !== undefined) && !numeric)
    return `${at} is not a number in returns, so it has no minimum or maximum`;
  for (const [key, field] of Object.entries(pass.properties ?? {})) {
    const own = returns.properties?.[key];
    if (!own || !returns.required?.includes(key)) return `${at}.${key} is not a required field of returns`;
    const why = whyPassUndecided(own, field, `${at}.${key}`);
    if (why) return why;
  }
  return undefined;
};

export const findMismatch = (type: ResultType, value: unknown, at = 'result'): string | undefined => {
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const said = (t: ResultType | undefined) => (t?.description ? ` (${t.description})` : '');
  if (type.type && type.type !== kind && !(type.type === 'integer' && Number.isInteger(value)))
    return `${at} must be ${type.type === 'integer' ? 'an integer' : `a ${type.type}`}${said(type)}`;
  if (type.type === 'integer' && !Number.isInteger(value)) return `${at} must be an integer${said(type)}`;
  if (type.enum && !type.enum.some(e => JSON.stringify(e) === JSON.stringify(value)))
    return `${at} must be one of ${JSON.stringify(type.enum)}${said(type)}`;
  if ('const' in type && JSON.stringify(type.const) !== JSON.stringify(value))
    return `${at} must be ${JSON.stringify(type.const)}${said(type)}`;
  if (typeof value === 'number' && type.minimum !== undefined && value < type.minimum)
    return `${at} must be at least ${type.minimum}${said(type)}`;
  if (typeof value === 'number' && type.maximum !== undefined && value > type.maximum)
    return `${at} must be at most ${type.maximum}${said(type)}`;
  if (Array.isArray(value) && type.items)
    for (const [i, item] of value.entries()) {
      const wrong = findMismatch(type.items, item, `${at}[${i}]`);
      if (wrong) return wrong;
    }
  if (kind !== 'object') return undefined;
  const fields = value as Record<string, unknown>;
  for (const key of type.required ?? [])
    if (!(key in fields)) return `${at}.${key} is missing${said(type.properties?.[key])}`;
  for (const [key, field] of Object.entries(type.properties ?? {})) {
    const wrong = key in fields ? findMismatch(field, fields[key], `${at}.${key}`) : undefined;
    if (wrong) return wrong;
  }
  return undefined;
};

const server = `
const findMismatch = ${findMismatch.toString()};
const schema = JSON.parse(process.argv[1]);
const tool = { name: 'result', description: process.argv[2], inputSchema: schema };
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const answer = ({ method, params }) => {
  if (method === 'initialize')
    return {
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'agentgraph', version: '1' },
    };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: [tool] };
  if (method !== 'tools/call' || params?.name !== 'result') return;
  const wrong = findMismatch(schema, params.arguments ?? null);
  return { content: [{ type: 'text', text: wrong ? wrong + '. Call result again.' : 'Recorded.' }], isError: !!wrong };
};
require('node:readline')
  .createInterface({ input: process.stdin })
  .on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'not JSON' } });
    }
    if (message?.id === undefined) return;
    const result = answer(message);
    send(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'unknown call' } });
  });
`;

export const makeResultServer = (returns: ResultType) => ({
  command: 'node',
  args: ['-e', server, JSON.stringify(returns), 'Records your result for the check. Call it once you have decided.'],
});

export const resultTool = 'mcp__agentgraph__result';

export const getRecordedResult = (returns: ResultType, event: { name: string; input: unknown; ok?: boolean }) =>
  event.ok && (event.name === resultTool || event.name === 'agentgraph_result') && !findMismatch(returns, event.input)
    ? (event.input as Result)
    : undefined;

export const readScriptResult = (output: string) => {
  try {
    const parsed: unknown = JSON.parse(output.trim().split('\n').at(-1) ?? '');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Result) : undefined;
  } catch {
    return undefined;
  }
};
