import { createContext, type ReactNode, use, useEffect, useId, useState } from 'react';
import { parse, stringify } from 'yaml';
import {
  currentChoice,
  type FieldIssue,
  initialValue,
  type JsonSchema,
  switchChoice,
  unionChoices,
} from '../../../../src/hub-files.ts';
import { Button, Chip, cx, RemovableChip, Segmented, useCommittedText } from '../../ui.tsx';

export type Path = (string | number)[];
type Target = { href: string; onClick: () => void };

/** What the form knows about the hub around it: suggestions for a field, links for a referenced name, open paths. */
export type FormContext = {
  issues: FieldIssue[];
  suggest: (path: Path) => string[] | undefined;
  link: (path: Path, value: string) => (Target & { icon?: ReactNode }) | undefined;
  open: (path: Path) => boolean;
};

const Ctx = createContext<FormContext | null>(null);
const useForm = () => use(Ctx)!;

const keyOf = (path: Path) => path.join('/');
const lastKey = (path: Path) => path.findLast(p => typeof p === 'string') ?? '';

const issuesAt = (issues: FieldIssue[], path: Path, deep: boolean) =>
  issues
    .filter(issue => {
      const k = keyOf(issue.path);
      const at = keyOf(path);
      return k === at || (deep && k.startsWith(`${at}/`));
    })
    .map(issue => issue.message);

const Issues = ({ path, deep = false }: { path: Path; deep?: boolean }) => {
  const messages = issuesAt(useForm().issues, path, deep);
  return messages.length ? (
    <ul className="mt-1 space-y-0.5 text-[11px] text-red-600 dark:text-red-400">
      {[...new Set(messages)].map(m => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  ) : null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (s: JsonSchema) => (Array.isArray(s.type) ? s.type[0] : s.type);

type Shape =
  | { kind: 'enum'; options: string[] }
  | { kind: 'const'; value: unknown }
  | { kind: 'string' | 'number' | 'integer' | 'boolean' }
  | { kind: 'object'; schema: JsonSchema }
  | { kind: 'record'; schema: JsonSchema }
  | { kind: 'multi'; options: string[] }
  | { kind: 'chips'; numeric: boolean; one: boolean }
  | { kind: 'objects'; item: JsonSchema }
  | { kind: 'union'; options: JsonSchema[] }
  | { kind: 'yaml' };

/** How to edit a value of `schema`: unions of a value and a list of it edit as the list, `null` options drop out. */
const shapeOf = (schema: JsonSchema): Shape => {
  const options = (schema.anyOf ?? schema.oneOf)?.filter(o => o.type !== 'null');
  if (options) {
    if (options.length === 1) return shapeOf(options[0]!);
    const list = options.find(o => o.type === 'array');
    const one = options.find(o => o !== list);
    if (list && one && options.length === 2 && typeOf(one) === typeOf(list.items ?? {})) {
      const shape = shapeOf(list);
      return shape.kind === 'chips' ? { ...shape, one: true } : shape;
    }
    return { kind: 'union', options };
  }
  if (schema.enum) return { kind: 'enum', options: schema.enum.map(String) };
  if (schema.const !== undefined) return { kind: 'const', value: schema.const };
  const type = typeOf(schema);
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return { kind: type };
  if (type === 'object') {
    if (schema.properties) return { kind: 'object', schema };
    if (typeof schema.additionalProperties === 'object') return { kind: 'record', schema };
    return { kind: 'yaml' };
  }
  if (type === 'array') {
    const item = schema.items ?? {};
    if (item.enum) return { kind: 'multi', options: item.enum.map(String) };
    const t = typeOf(item);
    if (t === 'string' || t === 'number' || t === 'integer')
      return { kind: 'chips', numeric: t !== 'string', one: false };
    if (t === 'object') return { kind: 'objects', item };
  }
  return { kind: 'yaml' };
};

const field =
  'rounded border border-zinc-300 bg-white px-2 py-1 text-[13px] outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-900';
const input = `${field} w-full`;
const mono = new Set([
  'run',
  'branch',
  'command',
  'cron',
  'paths',
  'tools',
  'types',
  'branches',
  'environment',
  'source',
]);

const EnumField = ({ options, value, onChange, path, required }: FieldProps & { options: string[] }) => {
  const set = (v: string | undefined) => onChange(v === undefined && required ? value : v);
  const short = options.length <= 5 && options.join('').length <= 40;
  if (short)
    return (
      <Segmented
        options={options}
        value={value as string | undefined}
        onChange={o => set(o === value ? undefined : o)}
        aria-label={String(lastKey(path))}
      />
    );
  return (
    <select
      className={input}
      value={(value as string | undefined) ?? ''}
      onChange={e => set(e.target.value || undefined)}
    >
      {!required && <option value="">-</option>}
      {options.map(o => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
};

const RefChip = ({ path, value, onRemove }: { path: Path; value: string; onRemove?: () => void }) => {
  const target = useForm().link(path, value);
  const chip = { mono: mono.has(String(lastKey(path))), title: target ? `open ${value}` : value, ...target };
  if (onRemove)
    return (
      <RemovableChip {...chip} label={value} onRemove={onRemove}>
        {value}
      </RemovableChip>
    );
  return <Chip {...chip}>{value}</Chip>;
};

const TextField = ({ value, onChange, path, required, schema }: FieldProps) => {
  const ctx = useForm();
  const id = useId();
  const key = String(lastKey(path));
  const { text, change, flush } = useCommittedText(
    typeof value === 'string' ? value : value === undefined ? '' : String(value),
    v => onChange(v === '' && !required ? undefined : v)
  );
  const suggestions = ctx.suggest(path);
  const multiline = key === 'run' || text.includes('\n') || text.length > 70;
  const link = text ? ctx.link(path, text) : undefined;
  return (
    <div className="space-y-1">
      {multiline ? (
        <textarea
          className={cx(input, 'min-h-16 font-mono text-xs')}
          value={text}
          rows={Math.min(8, text.split('\n').length + 1)}
          onChange={e => change(e.target.value)}
          onBlur={flush}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            className={cx(input, mono.has(key) && 'font-mono text-xs')}
            value={text}
            list={suggestions ? id : undefined}
            placeholder={schema.pattern ? undefined : ''}
            onChange={e => change(e.target.value)}
            onBlur={flush}
          />
          {link && <RefChip path={path} value={text} />}
        </div>
      )}
      {suggestions && (
        <datalist id={id}>
          {suggestions.map(s => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
};

const NumberField = ({ value, onChange, required, kind }: FieldProps & { kind: 'number' | 'integer' }) => {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  return (
    <input
      type="number"
      step={kind === 'integer' ? 1 : 'any'}
      className={cx(field, 'w-32 tabular-nums')}
      value={text}
      onChange={e => {
        setText(e.target.value);
        if (e.target.value === '') return onChange(required ? value : undefined);
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
};

const Toggle = ({ value, onChange, path }: FieldProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={value === true}
    aria-label={String(lastKey(path))}
    onClick={() => onChange(value === true ? undefined : true)}
    className={cx(
      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
      value === true ? 'bg-sky-600' : 'bg-zinc-300 dark:bg-zinc-700'
    )}
  >
    <span
      className={cx(
        'inline-block size-4 rounded-full bg-white shadow transition-transform',
        value === true ? 'translate-x-4.5' : 'translate-x-0.5'
      )}
    />
  </button>
);

const MultiField = ({ options, value, onChange, required }: FieldProps & { options: string[] }) => {
  const selected = Array.isArray(value) ? value.map(String) : [];
  const toggle = (option: string) => {
    const next = selected.includes(option) ? selected.filter(s => s !== option) : [...selected, option];
    onChange(next.length || required ? next : undefined);
  };
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(option => (
        <button
          key={option}
          type="button"
          aria-pressed={selected.includes(option)}
          onClick={() => toggle(option)}
          className={cx(
            'rounded-md border px-1.5 py-px text-xs leading-5',
            selected.includes(option)
              ? 'border-sky-500 bg-sky-50 text-sky-800 dark:border-sky-600 dark:bg-sky-950 dark:text-sky-200'
              : 'border-dashed border-zinc-300 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700'
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
};

const ChipsField = ({ value, onChange, path, required, numeric }: FieldProps & { numeric: boolean }) => {
  const ctx = useForm();
  const id = useId();
  const [draft, setDraft] = useState('');
  const items = (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(String);
  const set = (next: string[]) => {
    const typed = numeric ? next.map(Number) : next;
    onChange(typed.length || required ? typed : undefined);
  };
  const add = (text: string) => {
    const t = text.trim();
    if (!t || items.includes(t) || (numeric && !Number.isFinite(Number(t)))) return;
    set([...items, t]);
    setDraft('');
  };
  const suggestions = (ctx.suggest(path) ?? []).filter(s => !items.includes(s));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {items.map((item, i) => (
          <RefChip key={item} path={[...path, i]} value={item} onRemove={() => set(items.filter(x => x !== item))} />
        ))}
        <input
          className={cx(field, 'w-36 py-0.5 text-xs')}
          value={draft}
          list={suggestions.length ? id : undefined}
          placeholder="add"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && items.length) set(items.slice(0, -1));
          }}
          onBlur={() => add(draft)}
        />
      </div>
      {suggestions.length > 0 && (
        <>
          <datalist id={id}>
            {suggestions.map(s => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <div className="flex flex-wrap gap-1">
            {suggestions.slice(0, 16).map(s => (
              <Button key={s} variant="dashed" onClick={() => add(s)}>
                + {s}
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const YamlField = ({ value, onChange }: FieldProps) => {
  const shown = value === undefined ? '' : stringify(value, { lineWidth: 0 }).trimEnd();
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string>();
  useEffect(() => setText(shown), [shown]);
  return (
    <div>
      <textarea
        className={cx(input, 'min-h-12 font-mono text-xs')}
        value={text}
        rows={Math.min(10, text.split('\n').length + 1)}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          try {
            setError(undefined);
            onChange(text.trim() ? parse(text) : undefined);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
};

/**
 * A union: one choice among its enum values and object options, then the fields of the chosen option. Switching
 * keeps the fields both options share. An absent value shows the schema's default.
 */
const UnionField = ({ schema, options, value, onChange, path, required }: FieldProps & { options: JsonSchema[] }) => {
  const choices = unionChoices(options);
  const shown = value ?? schema.default;
  const current = currentChoice(choices, shown);
  return (
    <div className="space-y-2">
      <EnumField
        schema={schema}
        options={choices.map(c => c.label)}
        value={current?.label}
        path={path}
        required={required}
        onChange={label => {
          const next = choices.find(c => c.label === label);
          onChange(next ? switchChoice(next, value) : undefined);
        }}
      />
      {current && current.value === undefined && (
        <Value schema={current.option} value={shown} onChange={onChange} path={path} required />
      )}
    </div>
  );
};

type FieldProps = {
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  path: Path;
  required: boolean;
};

const Value = (props: FieldProps): ReactNode => {
  const shape = shapeOf(props.schema);
  switch (shape.kind) {
    case 'enum':
      return <EnumField {...props} options={shape.options} />;
    case 'const':
      return <span className="font-mono text-xs">{String(shape.value)}</span>;
    case 'string':
      return <TextField {...props} />;
    case 'number':
    case 'integer':
      return <NumberField {...props} kind={shape.kind} />;
    case 'boolean':
      return <Toggle {...props} />;
    case 'multi':
      return <MultiField {...props} options={shape.options} />;
    case 'chips':
      return <ChipsField {...props} numeric={shape.numeric} />;
    case 'object':
      return <ObjectFields {...props} schema={shape.schema} />;
    case 'record':
      return <RecordField {...props} schema={shape.schema} />;
    case 'objects':
      return <ObjectList {...props} item={shape.item} />;
    case 'union':
      return <UnionField {...props} options={shape.options} />;
    case 'yaml':
      return <YamlField {...props} />;
  }
};

const nested = (schema: JsonSchema) => {
  const shape = shapeOf(schema);
  if (shape.kind === 'union') return !shape.options.some(o => o.enum);
  return shape.kind === 'object' || shape.kind === 'record' || shape.kind === 'objects';
};

/** One labelled field. Grouped values get a bordered section; an absent optional group is one button to add it. */
const FieldRow = ({ name, ...props }: FieldProps & { name: string }) => {
  const group = nested(props.schema);
  if (group && props.value === undefined && !props.required)
    return (
      <div className="col-span-2">
        <Button variant="small" onClick={() => props.onChange(initialValue(props.schema))}>
          + {name}
        </Button>
      </div>
    );
  if (group)
    return (
      <fieldset className="col-span-2 space-y-2 rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
        <legend className="flex items-center gap-2 px-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {name}
          {!props.required && (
            <button
              type="button"
              className="text-zinc-400 hover:text-red-600"
              aria-label={`remove ${name}`}
              onClick={() => props.onChange(undefined)}
            >
              ×
            </button>
          )}
        </legend>
        <Value {...props} />
        <Issues path={props.path} />
      </fieldset>
    );
  return (
    <>
      <label className="pt-1 text-xs text-zinc-500">
        {name}
        {props.required && <span className="text-zinc-400"> *</span>}
      </label>
      <div className="min-w-0">
        <Value {...props} />
        <Issues path={props.path} deep />
      </div>
    </>
  );
};

const ObjectFields = ({ schema, value, onChange, path }: FieldProps) => {
  const data = isRecord(value) ? value : {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const set = (key: string) => (v: unknown) => {
    const next = { ...data };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const unknown = Object.keys(data).filter(k => !(k in props));
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-start gap-x-3 gap-y-2">
      {Object.entries(props)
        .filter(([, s]) => s.const === undefined)
        .map(([key, s]) => (
          <FieldRow
            key={key}
            name={key}
            schema={s}
            value={data[key]}
            onChange={set(key)}
            path={[...path, key]}
            required={required.has(key)}
          />
        ))}
      {unknown.map(key => (
        <FieldRow
          key={key}
          name={key}
          schema={{}}
          value={data[key]}
          onChange={set(key)}
          path={[...path, key]}
          required={false}
        />
      ))}
    </div>
  );
};

const renameKey = (data: Record<string, unknown>, from: string, to: string) =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k === from ? to : k, v]));

const RecordField = ({ schema, value, onChange, path }: FieldProps) => {
  const ctx = useForm();
  const data = isRecord(value) ? value : {};
  const item = typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {};
  const names = schema.propertyNames;
  const [adding, setAdding] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  const pattern = names?.pattern ? new RegExp(names.pattern) : undefined;
  const set = (key: string, v: unknown) =>
    onChange({ ...data, [key]: v === undefined ? (shapeOf(item).kind === 'object' ? null : v) : v });
  const remove = (key: string) => {
    const { [key]: _, ...rest } = data;
    onChange(rest);
  };
  const add = (key: string) => {
    if (!key || key in data || (pattern && !pattern.test(key))) return;
    onChange({ ...data, [key]: initialValue(item) });
    setOpened([...opened, key]);
    setAdding('');
  };
  const free = names?.enum?.map(String).filter(k => !(k in data));
  const singular = String(lastKey(path)).replace(/s$/, '');
  return (
    <div className="space-y-2">
      {Object.entries(data).map(([key, v]) => (
        <details
          key={key}
          open={ctx.open([...path, key]) || opened.includes(key) || undefined}
          className="group rounded-md border border-zinc-200 dark:border-zinc-800"
        >
          <summary className="flex cursor-pointer select-none items-center gap-2 px-2 py-1 text-xs marker:content-none [&::-webkit-details-marker]:hidden">
            <span className="inline-block text-zinc-400 transition-transform group-open:rotate-90">›</span>
            {names?.enum ? (
              <span className="font-medium">{key}</span>
            ) : (
              <KeyInput
                value={key}
                pattern={pattern}
                taken={Object.keys(data)}
                onRename={to => {
                  setOpened([...opened, to]);
                  onChange(renameKey(data, key, to));
                }}
              />
            )}
            {issuesAt(ctx.issues, [...path, key], true).length > 0 && (
              <span className="size-1.5 rounded-full bg-red-500" title="has problems" />
            )}
            <button
              type="button"
              className="ml-auto text-zinc-400 hover:text-red-600"
              aria-label={`remove ${key}`}
              onClick={() => remove(key)}
            >
              ×
            </button>
          </summary>
          <div className="border-t border-zinc-200 p-2.5 dark:border-zinc-800">
            <Value
              schema={item}
              value={v ?? undefined}
              onChange={next => set(key, next)}
              path={[...path, key]}
              required
            />
            <Issues path={[...path, key]} />
          </div>
        </details>
      ))}
      <div className="flex items-center gap-1.5">
        {free ? (
          free.length > 0 && (
            <select className={cx(field, 'py-0.5 text-xs')} value="" onChange={e => add(e.target.value)}>
              <option value="">+ add {singular}</option>
              {free.map(k => (
                <option key={k}>{k}</option>
              ))}
            </select>
          )
        ) : (
          <>
            <input
              className={cx(field, 'w-40 py-0.5 text-xs')}
              placeholder={`new ${singular} name`}
              value={adding}
              onChange={e => setAdding(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add(adding))}
            />
            <Button
              variant="small"
              disabled={!adding || (pattern && !pattern.test(adding))}
              onClick={() => add(adding)}
            >
              + add {singular}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

const KeyInput = ({
  value,
  pattern,
  taken,
  onRename,
}: {
  value: string;
  pattern: RegExp | undefined;
  taken: string[];
  onRename: (to: string) => void;
}) => {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const validName = (t: string) => t === value || (!!t && !taken.includes(t) && (!pattern || pattern.test(t)));
  const valid = validName(text);
  const commit = (t: string) => (validName(t) && t !== value ? onRename(t) : setText(value));
  return (
    <input
      aria-label="name"
      className={cx(
        'w-40 rounded bg-transparent px-1 font-medium outline-none focus:bg-white dark:focus:bg-zinc-900',
        !valid && 'text-red-600'
      )}
      value={text}
      onClick={e => e.preventDefault()}
      onKeyDown={e => {
        if (e.key === ' ') e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(e.currentTarget.value);
        }
      }}
      onChange={e => setText(e.target.value)}
      onBlur={e => commit(e.currentTarget.value)}
    />
  );
};

const ObjectList = ({ item, value, onChange, path, required }: FieldProps & { item: JsonSchema }) => {
  const items = Array.isArray(value) ? value : [];
  const set = (next: unknown[]) => onChange(next.length || required ? next : undefined);
  return (
    <div className="space-y-2">
      {items.map((v, i) => (
        <div key={i} className="relative rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <button
            type="button"
            className="absolute right-2 top-1 text-zinc-400 hover:text-red-600"
            aria-label="remove"
            onClick={() => set(items.filter((_, j) => j !== i))}
          >
            ×
          </button>
          <Value
            schema={item}
            value={v}
            onChange={n => set(items.map((x, j) => (j === i ? n : x)))}
            path={[...path, i]}
            required
          />
        </div>
      ))}
      <Button variant="small" onClick={() => set([...items, initialValue(item)])}>
        + add
      </Button>
    </div>
  );
};

/** An editor for any value of a JSON Schema: every property gets an input chosen from its type. */
export const SchemaForm = ({
  schema,
  value,
  onChange,
  context,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  context: FormContext;
}) => (
  <Ctx value={context}>
    <Value
      schema={schema}
      value={value}
      onChange={v => onChange((v ?? {}) as Record<string, unknown>)}
      path={[]}
      required
    />
    <Issues path={[]} />
  </Ctx>
);
