import type { ReactNode } from 'react';

/** A main area with a details column beside it and an optional footer underneath. */
export const StudioLayout = ({
  children,
  aside,
  footer,
}: {
  children: ReactNode;
  aside: ReactNode;
  footer?: ReactNode;
}) => (
  <div className="flex h-full flex-col">
    <div className="flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1">{children}</div>
      <aside className="w-[30rem] shrink-0 overflow-y-auto border-l border-zinc-200 p-4 dark:border-zinc-800">
        {aside}
      </aside>
    </div>
    {footer}
  </div>
);
