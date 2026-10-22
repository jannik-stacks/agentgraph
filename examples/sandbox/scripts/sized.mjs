import { readFileSync } from 'node:fs';

const proposals = JSON.parse(readFileSync(process.env.AGENTGRAPH_PROPOSALS, 'utf8'));
const sizes = ['XS', 'S', 'M', 'L', 'XL'];
const label = proposals
  .flatMap(p => (p.kind === 'label' ? (p.add ?? []) : []))
  .find(l => /^size\/(XS|S|M|L|XL)$/.test(l));
const parts = proposals.filter(p => p.kind === 'issue' && p.relation === 'part');
if (!label && !parts.length) {
  console.log('No size label proposed. Propose one `label` with a size/ label, or `ask` what is missing.');
  process.exit(1);
}
const parent = sizes.indexOf(label?.slice(5) ?? 'XL');
const big = parts.filter(p => sizes.indexOf(p.size) >= parent);
if (big.length) {
  const list = big.map(p => `"${p.title}" is ${p.size}`).join(', ');
  console.log(`Every part must be smaller than the issue (${sizes[parent]}); too big: ${list}. Split it further.`);
  process.exit(1);
}
