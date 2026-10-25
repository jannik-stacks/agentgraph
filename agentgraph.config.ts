import { claude } from './harnesses/claude.ts';
import { makeCodexHarness } from './harnesses/codex.ts';
import { opencode } from './harnesses/opencode.ts';
import { pi } from './harnesses/pi.ts';
import { makeProviders } from './harnesses/providers.ts';
import type { HarnessSettings } from './src/harnesses.ts';

export default {
  harnesses: [opencode(), claude(), pi(), makeCodexHarness()],
  providers: makeProviders(),
} satisfies HarnessSettings;
