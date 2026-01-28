#!/usr/bin/env node
import { program } from 'commander';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import $pkg from '../package.json' with { type: 'json' };
import { discoverSession } from './discovery.js';
import { normalizeURL } from './utils.js';

using rl = createInterface({
	input: process.stdin,
	output: process.stdout,
});

async function select(question: string, choices: string[], defaultValue?: string): Promise<string> {
	const maybeUnderline = (choice: string) => (choice == defaultValue ? styleText('underline', choice) : choice);
	return await rl.question(`${question} [${choices.map(maybeUnderline)}]: `);
}

const cli = program.name('eedu').version($pkg.version).description($pkg.description);

cli.command('discover')
	.description('Discover accounts (using browser cookies), courses, etc.')
	.argument('[url...]', "Sites to start discovery at (e.g. your institution's LMS)")
	.option('--no-browser', 'Do not discover using browser cookies', false)
	.action(async function eedu_discover(urls: string[]) {
		for (const { host } of urls.map(normalizeURL)) {
			if (!this.opts().browser) {
				const session = await discoverSession(host, { select });
				styleText('green', `+ ${session.domain}${session.platform ? ` (${session.platform})` : ''}`);
			}
		}
	});

cli.command('grades');

await cli.parseAsync();
