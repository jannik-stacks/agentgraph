import { hash } from 'node:crypto';

export const getSha = (text: Parameters<typeof hash>[1], length = 64) => hash('sha256', text, 'hex').slice(0, length);
