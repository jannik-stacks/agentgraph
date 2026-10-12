import { useAtomValue } from 'jotai';
import type { GraphModel, GraphNode } from '../graph-model.ts';
import { SourceView } from '../source/SourceView.tsx';
import { filesAtom } from '../state.ts';
import { Badge, Field, Fields, list, Pre, Section } from '../ui.tsx';

const NodeSource = ({ source }: { source: NonNullable<GraphNode['source']> }) => {
  const file = useAtomValue(filesAtom)?.find(f => f.root === source.root && f.path === source.path);
  return file ? (
    <Section title="source">
      <SourceView file={file} />
    </Section>
  ) : null;
};

export const NodeDetails = ({ node, model }: { node: GraphNode; model: GraphModel }) => {
  const label = (id: string) => model.nodes.find(n => n.id === id)?.label ?? id;
  const incoming = model.edges.filter(e => e.to === node.id).map(e => `${label(e.from)} (${e.kind})`);
  const outgoing = model.edges.filter(e => e.from === node.id).map(e => `${label(e.to)} (${e.kind})`);
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
          {node.kind}
          {node.badges?.map(badge => (
            <Badge key={badge.text} {...(badge.tone && { tone: badge.tone })}>
              {badge.text}
            </Badge>
          ))}
        </div>
        <h2 className="text-base font-semibold">{node.label}</h2>
        {node.detail?.summary && <p className="text-zinc-500">{node.detail.summary}</p>}
      </header>
      <Fields>
        {node.detail?.fields?.map(([name, value]) => (
          <Field key={name} name={name}>
            {value}
          </Field>
        ))}
        <Field name="in">{list(incoming)}</Field>
        <Field name="out">{list(outgoing)}</Field>
      </Fields>
      {node.detail?.sections?.map(section => (
        <Section key={section.title} title={section.title}>
          <Pre>{section.body}</Pre>
        </Section>
      ))}
      {node.source && <NodeSource source={node.source} />}
    </div>
  );
};
