import type { Effect } from 'effect';
import type { Applied, Forge, ForgeError, Proposal } from './forge.ts';
import type { Hub } from './hub.ts';
import type { Sandbox, SandboxError } from './sandbox.ts';
import type { Services } from './services.ts';
import type { Session, SessionStop } from './session.ts';
import type { Store, StoreError } from './store.ts';
import { todo } from './todo.ts';
import type { Outcome, Run, Step, Workflow } from './workflow.ts';

/** One try of the current step: a session, a script or a wait, then the gate, then land on a pass. */
export const attempt = (
  _w: Workflow,
  _run: Run,
  _hub: Hub
): Effect.Effect<Outcome, SandboxError | SessionStop | ForgeError, Services> => todo('attempt');

/** The step's checks over what a try left behind: scripts in one batch, bot checks only when no script failed. */
export const gate = (
  _step: Step,
  _left: { dir: string; base: string; proposals: Proposal[] },
  _hub: Hub
): Effect.Effect<Outcome, SandboxError, Sandbox | Session | Store> => todo('gate');

/** Applies the accepted proposals after a pass. */
export const land = (_run: Run, _proposals: Proposal[]): Effect.Effect<Applied[], ForgeError, Forge> => todo('land');

/** attempt, transition and persist until the run is no longer running. */
export const drive = (_w: Workflow, _run: Run, _hub: Hub): Effect.Effect<Run, StoreError, Services> => todo('drive');

/** One look at the repo: reenter parked runs, begin new ones, drive up to `limits.working`. */
export const tick = (_hub: Hub): Effect.Effect<Run[], ForgeError | StoreError, Services> => todo('tick');
