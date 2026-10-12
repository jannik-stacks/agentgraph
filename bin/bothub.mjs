#!/usr/bin/env node
import { argv, exit } from 'node:process';
import { main } from '../src/cli.ts';

exit(await main(argv.slice(2)));
