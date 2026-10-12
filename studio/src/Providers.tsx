import { FrameworkProvider } from 'fumadocs-core/framework';
import { RootProvider } from 'fumadocs-ui/provider/base';
import { useAtomValue, useSetAtom } from 'jotai';
import { type ComponentProps, type ReactNode, useMemo } from 'react';
import { docsSlugAtom, locationAtom, navigateAtom } from './state.ts';

const isInternal = (href: string | undefined): href is string => !!href?.startsWith('/') && !href.startsWith('//');

/** An anchor that navigates in-app for same-origin paths and leaves everything else to the browser. */
export const Link = ({ href, prefetch: _, onClick, ...props }: ComponentProps<'a'> & { prefetch?: boolean }) => {
  const navigate = useSetAtom(navigateAtom);
  return (
    <a
      href={href}
      {...props}
      onClick={e => {
        onClick?.(e);
        if (e.defaultPrevented || !isInternal(href)) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || props.target) return;
        e.preventDefault();
        const url = new URL(href, location.origin);
        navigate({ path: url.pathname });
        if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
        else scrollTo(0, 0);
      }}
    />
  );
};

const usePathname = () => useAtomValue(locationAtom).path;
const useParams = () => ({ slug: useAtomValue(docsSlugAtom) });
const useRouter = () => {
  const navigate = useSetAtom(navigateAtom);
  return useMemo(() => ({ push: (path: string) => navigate({ path }), refresh: () => {} }), [navigate]);
};

/** Fumadocs on the app's own History API routing. The `dark` class follows the system, set in index.html. */
export const Providers = ({ children }: { children: ReactNode }) => (
  <FrameworkProvider usePathname={usePathname} useParams={useParams} useRouter={useRouter} Link={Link}>
    <RootProvider search={{ enabled: false }} theme={{ enabled: false }}>
      {children}
    </RootProvider>
  </FrameworkProvider>
);
