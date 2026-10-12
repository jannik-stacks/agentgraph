declare module 'virtual:bothub-code' {
  export const files: import('./model.ts').Files;
  export const loaders: Record<string, () => Promise<{ default: import('./model.ts').FileText }>>;
}
