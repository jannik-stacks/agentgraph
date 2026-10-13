// Fails a triage reply that breaks the brief template: the four sections in order, at most five criteria, and each
// criterion one line ending in the test title and test file that prove it.
//
//   node triage-brief.mjs [reply-file]      otherwise the reply is read from BOTHUB_REPLY
import { readFileSync } from 'node:fs';
import { parseBrief } from './brief.mjs';
import { report } from './changes.mjs';

const reply = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : process.env.BOTHUB_REPLY;
if (reply === undefined) console.log('triage-brief: no reply to check; it is read from BOTHUB_REPLY');
else report('triage-brief', parseBrief(reply).problems);
