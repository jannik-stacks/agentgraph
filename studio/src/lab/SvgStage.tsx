import { useEffect, useRef, useState } from 'react';

type View = { x: number; y: number; k: number };

const size = (svg: SVGSVGElement) => {
  const box = svg.viewBox.baseVal;
  if (box && box.width) return { width: box.width, height: box.height };
  const bbox = svg.getBBox();
  return { width: bbox.width, height: bbox.height };
};

/**
 * Shows an SVG string or element with wheel zoom and drag pan. `tag` marks clickable shapes with `data-state`, which
 * drives selection both ways.
 */
export const SvgStage = ({
  load,
  tag,
  selected,
  onSelect,
}: {
  load: () => Promise<string | SVGSVGElement>;
  tag: (svg: SVGSVGElement) => void;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}) => {
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    setReady(false);
    setError(undefined);
    load().then(
      result => {
        if (!live || !host.current || !frame.current) return;
        host.current.replaceChildren();
        if (typeof result === 'string') host.current.innerHTML = result;
        else host.current.append(result);
        const svg = host.current.querySelector('svg');
        if (!svg) return setError('no svg in the output');
        svg.removeAttribute('style');
        const { width, height } = size(svg);
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        tag(svg);
        const { clientWidth, clientHeight } = frame.current;
        const k = Math.min(clientWidth / width, clientHeight / height, 1.5) * 0.95;
        setView({ k, x: (clientWidth - width * k) / 2, y: (clientHeight - height * k) / 2 });
        setReady(true);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e))
    );
    return () => {
      live = false;
    };
  }, [load, tag]);

  useEffect(() => {
    const root = host.current;
    if (!root || !ready) return;
    root.querySelectorAll('.lab-selected').forEach(el => el.classList.remove('lab-selected'));
    if (selected) root.querySelector(`[data-state="${CSS.escape(selected)}"]`)?.classList.add('lab-selected');
  }, [selected, ready]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const [px, py] = [event.clientX - rect.left, event.clientY - rect.top];
      setView(v => {
        const k = Math.min(4, Math.max(0.05, v.k * Math.exp(-event.deltaY / 400)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  return (
    <div
      ref={frame}
      className="lab-stage relative h-full w-full cursor-grab overflow-hidden bg-white active:cursor-grabbing"
      onPointerDown={event => {
        drag.current = { x: event.clientX, y: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const d = drag.current;
        if (!d) return;
        const [dx, dy] = [event.clientX - d.x, event.clientY - d.y];
        if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
        drag.current = { x: event.clientX, y: event.clientY, moved: d.moved };
        setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }}
      onPointerUp={event => {
        const moved = drag.current?.moved;
        drag.current = null;
        if (moved) return;
        const target = document.elementFromPoint(event.clientX, event.clientY);
        onSelect(target?.closest('[data-state]')?.getAttribute('data-state') ?? undefined);
      }}
    >
      {error && <p className="p-4 text-red-600">{error}</p>}
      <div
        ref={host}
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          visibility: ready ? 'visible' : 'hidden',
        }}
      />
      {!ready && !error && <p className="p-4 text-zinc-500">Rendering.</p>}
    </div>
  );
};
