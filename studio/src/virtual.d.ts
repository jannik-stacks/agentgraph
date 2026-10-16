declare module 'virtual:fixtures' {
  export const fixtures: import('./graph/scenarios.ts').Fixture[];
  /** The served hub, with the problems that stop the engine loading it. */
  export const served: { name: string; problems: import('../../src/workflow.ts').Problem[] } | null;
}
