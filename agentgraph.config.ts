import { opencode } from './harnesses/opencode.ts';
import { pi } from './harnesses/pi.ts';
import { claude, type Config } from './src/harnesses.ts';

export default { harnesses: [opencode(), claude(), pi()] } satisfies Config;
