import type { Harness, Load } from '../schema.ts';

/** What each harness can honor beyond the basics: `Load` kinds from the target repo, and `resume` context. */
export const supports: Record<Harness, readonly (Load | 'resume')[]> = {
  opencode: ['instructions', 'skills', 'resume'],
  pi: [],
  claude: [],
};
