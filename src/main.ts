#!/usr/bin/env node
import { program } from 'commander';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import $pkg from '../package.json' with { type: 'json' };
import * as canvas from './platforms/canvas.js';
import { errorText, normalizeURL } from './utils.js';

using rl = createInterface({
	input: process.stdin,
	output: process.stdout,
});

async function select(question: string, choices: string[], defaultValue?: string): Promise<string> {
	const maybeUnderline = (choice: string) => (choice == defaultValue ? styleText('underline', choice) : choice);
	return await rl.question(`${question} [${choices.map(maybeUnderline)}]: `);
}

const cli = program.name('eedu').version($pkg.version).description($pkg.description);

const cli_discover = cli.command('discover').description('Discover accounts, courses, etc.');

cli_discover
	.command('canvas')
	.description('Discover courses and other info from a Canvas LMS')
	.argument('[domain]', 'The domain of the Canvas instance, e.g. canvas.instructure.com')
	.option('-r, --recursive', 'If discovery finds integrations with other platforms (e.g. ZyBooks), run discovery on those as well', false)
	.action(async (domain: string | undefined, { recursive }) => {
		if (domain) {
			if (canvas.data.origin) console.log('Note: overwriting Canvas origin');
			canvas.data.origin = normalizeURL(domain).origin;
		}

		if (!canvas.data.token) {
			/**
			 * @todo use OAuth2 because Canvas access tokens because according to the API docs:
			 * > Note that asking any other user to manually generate a token and enter it into your application is a violation of Canvas' API Policy.
			 * > Applications in use by multiple users MUST use OAuth to obtain tokens.
			 */
			const token = await rl.question(`Enter your access token (from ${canvas.data.origin}/profile/settings#access_tokens_holder): `);
			canvas.data.token = token.trim();
		}

		canvas.writeData();

		const user = await canvas.api('GET', 'users/self');
		console.log(`Courses for ${user.name}:`);

		for (const course of await canvas.api('GET', 'courses')) {
			console.log('*', course.name);

			if (!recursive) return;

			const modules = await canvas.api('GET', `courses/${course.id}/modules?include[]=items`);

			for (const module of modules) {
				module.items ||= await canvas.api('GET', module.items);
				for (const item of module.items) {
					if (item.type != 'ExternalTool') continue;

					const { hostname } = new URL(item.external_url);
					if (hostname.endsWith('.zybooks.com')) {
						console.log('\t+', module.name, '->', item.title, '[ZyBook]');
						/** @todo figure out how to grab the ZyBooks session/user */
					}
				}
			}
		}
	});

cli.command('grades');

process.on('uncaughtException', err => {
	console.error(styleText('red', 'Error:'), errorText(err));
});

await cli.parseAsync();
