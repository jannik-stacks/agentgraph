// oxlint-disable typescript/consistent-type-imports -- an ambient module cannot import a relative path
declare module 'virtual:fixtures' {
  export const fixtures: import('./graph/scenarios.ts').Fixture[];
}

declare module 'virtual:served' {
  export const served: {
    name: string;
    title: string;
    local: boolean;
    problems: import('../../src/workflow.ts').Problem[];
  }[];
}

declare module 'virtual:agentgraph-pages' {
  export const pages: {
    name: string;
    title: string;
    href: string;
    builtin: boolean;
    instance?: string;
    load: () => Promise<{ default: import('react').ComponentType }>;
  }[];
}
