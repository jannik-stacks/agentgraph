import { opencode } from './harnesses/opencode.ts';
import { claude, type Config, pi } from './src/harnesses.ts';

export default { harnesses: [opencode(), claude(), pi()] } satisfies Config;
