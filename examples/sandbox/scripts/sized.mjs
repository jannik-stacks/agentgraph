import { readFileSync } from 'node:fs';

const proposals = JSON.parse(readFileSync(process.env.BOTHUB_PROPOSALS, 'utf8'));
const sized = proposals.some(
  p => p.kind === 'issue' || (p.kind === 'label' && (p.add ?? []).some(l => /^size\/(XS|S|M|L|XL)$/.test(l)))
);
if (!sized) console.log('No size label proposed. Propose one `label` with a size/ label, or `ask` what is missing.');
process.exit(sized ? 0 : 1);
