import { useAtom, useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { type SourceFile, SourceView } from '../source/SourceView.tsx';
import { filesAtom, selectedFileAtom } from '../state.ts';
import { cx, Disclosure, Muted } from '../ui.tsx';

type Dir = { name: string; dirs: Dir[]; files: SourceFile[] };

const fileKey = (file: SourceFile) => `${file.root}:${file.path}`;

const buildTree = (files: SourceFile[]) => {
  const roots: Dir[] = [];
  for (const file of files) {
    let dir = roots.find(r => r.name === file.root);
    if (!dir) roots.push((dir = { name: file.root, dirs: [], files: [] }));
    const parts = file.path.split('/');
    for (const part of parts.slice(0, -1)) {
      let next: Dir | undefined = dir.dirs.find(d => d.name === part);
      if (!next) dir.dirs.push((next = { name: part, dirs: [], files: [] }));
      dir = next;
    }
    dir.files.push(file);
  }
  return roots;
};

const Tree = ({ dir, selected, onSelect }: { dir: Dir; selected: string | null; onSelect: (key: string) => void }) => (
  <Disclosure open summary={`${dir.name}/`} summaryClassName="py-0.5 text-zinc-500">
    <ul className="ml-3 border-l border-zinc-200 pl-2 dark:border-zinc-800">
      {dir.dirs.map(child => (
        <li key={child.name}>
          <Tree dir={child} selected={selected} onSelect={onSelect} />
        </li>
      ))}
      {dir.files.map(file => (
        <li key={file.path}>
          <button
            onClick={() => onSelect(fileKey(file))}
            className={cx(
              'w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-xs',
              fileKey(file) === selected
                ? 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
            )}
          >
            {file.path.split('/').pop()}
          </button>
        </li>
      ))}
    </ul>
  </Disclosure>
);

/** Every file the setup needs, per root, with the selected file's source. */
export const SetupView = () => {
  const files = useAtomValue(filesAtom);
  const [selected, select] = useAtom(selectedFileAtom);
  const roots = useMemo(() => buildTree(files ?? []), [files]);
  if (!files) return <Muted>Loading files.</Muted>;
  if (!files.length) return <Muted>No files found in the hub or infra directories.</Muted>;
  const file = files.find(f => fileKey(f) === selected) ?? files[0];
  return (
    <div className="flex h-full">
      <nav className="bhm-scroll-fade w-72 shrink-0 overflow-y-auto border-r border-zinc-200 p-3 dark:border-zinc-800">
        {roots.map(root => (
          <Tree key={root.name} dir={root} selected={file ? fileKey(file) : null} onSelect={select} />
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">{file && <SourceView file={file} />}</div>
    </div>
  );
};
