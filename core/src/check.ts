/** A check is items, a command and an agent that judges. `stop` ends the run when it fails. */
export type Check = {
  mode: 'warn' | 'block' | 'stop';
  each?: string;
  run?: string;
  agent?: string;
  max?: number;
};

export type CheckResult = { check: string; pass: boolean; findings?: string; ms: number };
