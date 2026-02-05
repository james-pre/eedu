#!/usr/bin/env node
import { program } from 'commander';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import $pkg from '../package.json' with { type: 'json' };
import { courses } from './data.js';
import { setHandlers } from './discovery.js';
import * as canvas from './platforms/canvas.js';
import * as zybooks from './platforms/zybooks.js';
import { errorText } from './utils.js';
import { stringbool } from 'zod';
import { debugMode } from './config.js';

using rl = createInterface({
	input: process.stdin,
	output: process.stdout,
});

async function rlConfirm(question: string = 'Is this ok'): Promise<void> {
	const abort = () => {
		console.error(styleText('red', 'Aborted.'));
		process.exit(1);
	};

	const { data, error } = stringbool()
		.default(false)
		.safeParse(await rl.question(question + ' [y/N]: ').catch(abort));
	if (error || !data) abort();
}

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
	.option('-r, --recursive', 'If discovery finds integrations with other platforms (e.g. ZyBooks), run discovery on those as well', false)
	.action(canvas.discover);

cli_discover.command('zybooks').description('Discover books from ZyBooks').action(zybooks.discover);

const cli_auto = cli
	.command('autocomplete')
	.alias('auto')
	.description('Automatically complete actions')
	.option('-y, --no-confirm', 'Do not ask for confirmation')
	.hook('preAction', async cmd => {
		if (cmd.opts().confirm) await rlConfirm('Do you accept responsibility for any consequences resulting from this automation');
	});

cli_auto
	.command('zybooks')
	.description('Auto-complete ZyBook activities')
	.argument('[books...]', 'ZyBook book codes to auto-complete', zybooks.data.books)
	.option('--dry-run', 'Do not send completion requests', false)
	.option('-C, --chapter <n>', 'Chapter to auto-complete (1-based index)', parseInt)
	.option('-S, --section <n>', 'Section to auto-complete (1-based index)', parseInt)
	.action(async (books, options) => {
		for (const book of books) {
			await zybooks.autoComplete(book, {
				...options,
				onComplete(chapter, section, resource, part) {
					let text = `${styleText('green', 'Completing')} ${chapter.number}.${section.number}.${resource._number}`;
					if (typeof part == 'number') text += ` (${part + 1}/${resource.parts})`;
					console.log(text);
				},
				onSkip(chapter, section, resource, reason, show) {
					if (!show && !debugMode) return;
					let text = `${styleText(show ? 'yellow' : 'dim', 'Skipping')} ${chapter.number}.${section.number}.${resource._number}`;
					if (reason) text += `: ${reason}`;
					console.log(text);
				},
			});
		}
	});

cli.command('grades');

process.on('uncaughtException', err => {
	console.error(styleText('red', 'Error:'), errorText(err));
	if (debugMode && err instanceof Error && err.stack) console.error(styleText('dim', err.stack.split('\n').slice(1).join('\n')));
});

await cli.parseAsync();
