#!/usr/bin/env node
import { program } from 'commander';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import $pkg from '../package.json' with { type: 'json' };
import { setHandlers } from './discovery.js';
import * as canvas from './platforms/canvas.js';
import * as zybooks from './platforms/zybooks.js';
import { errorText, normalizeURL } from './utils.js';
import { courses } from './data.js';

using rl = createInterface({
	input: process.stdin,
	output: process.stdout,
});

const cli = program.name('eedu').version($pkg.version).description($pkg.description);

const cli_courses = cli.command('courses').description('Manage courses');

cli_courses
	.command('list')
	.alias('ls')
	.description('List courses')
	.option('-l, --long', 'Use long listing format', false)
	.action(opts => {
		if (!opts.long) {
			console.log(courses.map(c => c.name).join('\n'));
			return;
		}

		for (const course of courses) {
			console.log(course.name);
		}
	});

const cli_discover = cli.command('discover').description('Discover accounts, courses, etc.');
setHandlers({
	async select(question: string, choices: string[], defaultValue?: string): Promise<string> {
		const maybeUnderline = (choice: string) => (choice == defaultValue ? styleText('underline', choice) : choice);
		return await rl.question(`${question} [${choices.map(maybeUnderline)}]: `);
	},
	async prompt(question: string, defaultValue: string = ''): Promise<string> {
		if (defaultValue) question += ` [${defaultValue}]`;
		const value = await rl.question(question);
		return value || defaultValue;
	},
	onAdd(...text: string[]) {
		console.log(styleText('green', ['+', ...text].join(' ')));
	},
});

cli_discover
	.command('canvas')
	.description('Discover courses and other info from a Canvas LMS')
	.argument('[domain]', 'The domain of the Canvas instance, e.g. canvas.instructure.com')
	.option('-r, --recursive', 'If discovery finds integrations with other platforms (e.g. ZyBooks), run discovery on those as well', false)
	.action(async (domain: string | undefined, options) => {
		if (domain) {
			if (canvas.data.origin) console.log('Note: overwriting Canvas origin');
			canvas.data.origin = normalizeURL(domain).origin;
		}

		await canvas.discover(options);
	});

cli_discover.command('zybooks').description('Discover books from ZyBooks').action(zybooks.discover);

cli.command('grades');

process.on('uncaughtException', err => {
	console.error(styleText('red', 'Error:'), errorText(err));
});

await cli.parseAsync();
