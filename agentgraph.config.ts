import { claude } from './harnesses/claude.ts';
import { opencode } from './harnesses/opencode.ts';
import { pi } from './harnesses/pi.ts';
import type { HarnessSettings } from './src/harnesses.ts';

export default { harnesses: [opencode(), claude(), pi()] } satisfies HarnessSettings;
