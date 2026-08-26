#!/usr/bin/env node

import * as io from 'ioium/node';
import { styleText } from 'node:util';
import { debugMode } from './config.js';
import cli from './cli.js';

process.on('uncaughtException', err => {
	console.error(styleText('red', 'Error:'), io.errorText(err));
	if (debugMode && err instanceof Error && err.stack) console.error(styleText('dim', err.stack.split('\n').slice(1).join('\n')));
});

try {
	await cli.parseAsync();
} catch (e) {
	io.exit(e);
}
