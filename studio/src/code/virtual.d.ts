declare module 'virtual:bothub-code' {
  /** Absolute path of the bothub package, for editor links. */
  export const root: string;
  /** The highlight classes the snippets use. */
  export const css: string;
  export const refs: Record<string, import('./model.ts').Ref>;
}
