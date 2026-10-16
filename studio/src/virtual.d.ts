declare module 'virtual:fixtures' {
  export const fixtures: import('./graph/views/scenarios.ts').Fixture[];
  /** The served hub when it is in core format, with the problems that stop core loading it. */
  export const served: { name: string; problems: import('../../core/src/workflow.ts').Problem[] } | null;
}
