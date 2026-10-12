import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect } from 'react';
import { codeComponents } from '../code/components.tsx';
import { docsSlugAtom } from '../state.ts';
import { HubGraph } from './HubGraph.tsx';
import { source } from './source.ts';

const components = { ...defaultMdxComponents, ...codeComponents, HubGraph };
const tree = source.getPageTree();

const Page = () => {
  const slug = useAtomValue(docsSlugAtom);
  const page = source.getPage(slug);
  useEffect(() => {
    document.title = page ? `${page.data.title} | bothub docs` : 'bothub docs';
    return () => void (document.title = 'BHM');
  }, [page]);
  if (!page)
    return (
      <DocsPage>
        <DocsTitle>Not found</DocsTitle>
      </DocsPage>
    );
  const Body = page.data.body;
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <Body components={components} />
      </DocsBody>
    </DocsPage>
  );
};

export default function DocsView() {
  return (
    <DocsLayout
      tree={tree}
      nav={{ title: 'Docs', url: '/docs' }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      containerProps={{ style: { '--fd-banner-height': '3rem' } as CSSProperties }}
    >
      <Page />
    </DocsLayout>
  );
}
