import { Command, Option } from 'commander';
import * as io from 'ioium/node';
import { basename } from 'node:path';
import { styleText } from 'node:util';
import * as z from 'zod';
import $pkg from '../package.json' with { type: 'json' };
import { debugMode } from './config.js';
import { school } from './data.js';
import { setHandlers } from './discovery.js';
import * as canvas from './platforms/canvas.js';
import * as qemu from './platforms/qemu.js';
import * as zybooks from './platforms/zybooks.js';
import * as grades from './grades.js';

const cli = new Command('eedu').version($pkg.version).description($pkg.description);

export default cli;

const cli_courses = cli.command('courses').description('Manage courses').option('--debug', 'Enable debug mode', false);

cli_courses
	.command('list')
	.alias('ls')
	.description('List courses')
	.option('-l, --long', 'Use long listing format', false)
	.action(opts => {
		if (!opts.long) {
			console.log(school.data.courses.map(c => c.name).join('\n'));
			return;
		}

		for (const course of school.data.courses) {
			console.log(course.name);
		}
	});

cli_courses
	.command('add')
	.description('Add a course')
	.argument('<id>', 'Course ID')
	.argument('<name>', 'Course name')
	.argument('<term>', 'Course term')
	.action(async (id, name, term, options) => {
		school.data.courses.push({ id, name, term });
		school.update({ courses: school.data.courses });
	});

const cli_discover = cli.command('discover').description('Discover accounts, courses, etc.');

setHandlers({
	async select(question: string, choices: string[], defaultValue?: string): Promise<string> {
		const maybeUnderline = (choice: string) => (choice == defaultValue ? styleText('underline', choice) : choice);
		using rl = io.getReadline();
		return await rl.question(`${question} [${choices.map(maybeUnderline)}]: `);
	},
	async prompt(question: string, defaultValue: string = ''): Promise<string> {
		if (defaultValue) question += ` [${defaultValue}]`;
		using rl = io.getReadline();
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

cli_discover.command('qemu').description('Discover the VM, its dimensions, and paths used for screen automation').action(qemu.discover);

const cli_auto = cli
	.command('autocomplete')
	.alias('auto')
	.description('Automatically complete actions')
	.option('-y, --no-confirm', 'Do not ask for confirmation')
	.hook('preAction', async cmd => {
		if (cmd.opts().confirm) await io.assertYes('Do you accept responsibility for any consequences resulting from this automation');
	});

cli_auto
	.command('zybooks')
	.description('Auto-complete ZyBook activities')
	.argument('[books...]', 'ZyBook book codes to auto-complete', zybooks.data.books)
	.option('--dry-run', 'Do not send completion requests', false)
	.option('-f, --force', 'Force re-completion of already completed activities', false)
	.option('-C, --chapter <n>', 'Chapter to auto-complete (1-based index)', parseInt)
	.option('-S, --section <n>', 'Section to auto-complete (1-based index)', parseInt)
	.option('--show-names', 'Show activity names', false)
	.action(async (books, options) => {
		for (const book of books) {
			await zybooks.autoComplete(book, {
				...options,
				onComplete(name, resource, part) {
					let text = `${styleText('green', 'Completing')} ${name}`;
					if (typeof part == 'number') text += ` part ${part + 1}/${resource.parts}`;
					console.log(text);
				},
				onSkip(name, resource, reason, show) {
					if (!show && !debugMode) return;
					let text = `${styleText(show ? 'yellow' : 'dim', 'Skipping')} ${name}`;
					if (reason) text += `: ${reason}`;
					console.log(text);
				},
			});
		}
	});

cli_auto
	.command('qemu')
	.description('Answer questions visible on a VM screen, scrolling until the screen stops changing')
	.option('-n, --pages <n>', 'Stop after this many screenfuls', v => parseInt(v), 50)
	.option('-1, --once', 'One screenful, no scroll (end-to-end smoke test)', false)
	.option('-o, --out <path>', 'Answers file, if not specified write to standard output')
	.option('--no-scroll', 'Answer but never scroll')
	.option(
		'-i, --initial-scroll <amount>',
		'How much to scroll before the first screenshot, for pages that start above the questions',
		v => parseInt(v),
		3
	)
	.option('--explain', 'Ask for a one-line reason with each answer', false)
	.option('--resume', 'Append to an existing answers file, skipping questions already recorded in it', false)
	.action(async options => {
		await qemu.autoComplete({
			...options,
			pages: options.once ? 1 : options.pages,
			scroll: options.scroll && !options.once,
			onResume(count, out) {
				console.log(`resuming: ${count} question(s) already in ${basename(out)}`);
			},
			onAnswer: console.log,
			onPage(page, added, total) {
				console.log(styleText('dim', `page ${page}: ${added} new answer(s) (total ${total})`));
			},
			onError(page, error) {
				io.warn(`claude failed on page ${page}: ${error}`);
			},
			onDone(total, out) {
				console.log('answers:', total + (out ? ', saved to ' + out : ''));
			},
		});
	});

const cli_grades = cli.command('grades').description('Manage grades');

const percent = (x: number) => (x * 100).toFixed(1) + '%';
const points = (item?: grades.Item) => (item ? `${item.score ?? '?'}/${item.possible}` : '');
const status = (item: grades.Item) =>
	styleText('yellow', [item.ignored && 'ignored', !item.possible && 'not counted', item.moved && 'moved'].filter(x => x).join(', '));

cli_grades
	.command('show')
	.description('Show grades')
	.option('-a, --all-terms', 'Show grades for all terms, not just the active ones', false)
	.option('-l, --long', 'Show details for each category', false)
	.option('-p, --predict', 'Predict category grades based on current score averages', false)
	.option('-P, --predict-full-category', 'Predict scores for completely unknown categories using known ones (likely inaccurate)', false)
	.option(
		'--error-alignment <n>',
		'Spaces used in place of a missing error percentage, may fix alignment on some terminals',
		v => parseInt(v),
		9
	)
	.argument('[course]', 'Course ID or name to show grades for, supports partial matches and is case insensitive')
	.addHelpText(
		'after',
		`
Percentage colors:
  Red = failing
  Yellow = below target
  Cyan = meets target
  Green = meets ideal
  Blue = otherwise`
	)
	.action((course, options) => {
		const courses = grades.findCourses(course, options.allTerms);
		if (course && !courses.length) throw new Error('No grades found for ' + course);
		for (const course of courses) grades.show(course.name, course.grades, options);
	});

cli_grades
	.command('pull')
	.description('Fetch grades from discovered platforms')
	.option('-a, --all-terms', 'Fetch grades for all terms, not just the active ones', false)
	.action(async options => {
		const changes = await grades.pull([canvas.grades], options.allTerms);
		if (!changes.length) {
			console.log('No new or updated grades.');
			return;
		}

		io.table(
			[
				{ name: 'ID', text: c => c.id },
				{ name: 'Course', text: c => c.course.name },
				{ name: 'Category', text: c => c.category },
				{ name: 'Name', text: c => c.item.name },
				{ name: 'Previous', text: c => styleText('dim', points(c.previous)), padStart: true },
				{ name: 'Score', text: c => points(c.item), padStart: true },
				{ name: 'Status', text: c => status(c.item), grow: 0 },
			],
			{ formatHead: text => styleText('bold', text) },
			changes
		);
		console.log(styleText('dim', 'Use `eedu grades ignore <id...>` to exclude grades that should not count.'));
	});

cli_grades
	.command('list')
	.alias('ls')
	.description('List grades')
	.option('-a, --all-terms', 'Include courses from all terms, not just the active ones', false)
	.option('-c, --course <course>', 'Only courses whose ID or name contains this (case insensitive)')
	.option('-C, --category <category>', 'Only categories whose name contains this (case insensitive)')
	.action(options => {
		const rows = grades.listGrades(options);
		if (!rows.length) {
			console.log('No grades.');
			return;
		}

		io.table(
			[
				{ name: 'ID', text: r => r.id },
				{ name: 'Course', text: r => r.course.name },
				{ name: 'Category', text: r => r.category },
				{ name: 'Name', text: r => r.item.name },
				{ name: 'Score', text: r => points(r.item), padStart: true },
				{
					name: '%',
					text: r => (r.item.score === null || !r.item.possible ? '' : percent(r.item.score / r.item.possible)),
					padStart: true,
				},
				{ name: 'Status', text: r => status(r.item), grow: 0 },
			],
			{ formatHead: text => styleText('bold', text) },
			rows
		);
	});

cli_grades
	.command('add')
	.description('Add a grade by hand')
	.argument('<name>', 'Name of the assignment')
	.argument('<score>', 'Points like 8/10, ?/10 if not graded yet, or a percentage like 85%', v => grades.Points.parse(v))
	.option('-c, --course <course>', 'Course ID or name, supports partial matches and is case insensitive (prompted for if omitted)')
	.option('-C, --category <category>', 'Category name, supports partial matches and is case insensitive (prompted for if omitted)')
	.action(async (name, score, options) => {
		const course = await grades.resolveCourse(options.course);
		const category = await grades.resolveCategory(course, options.category);
		const id = grades.addGrade(course.id, category, name, score);
		console.log(`Added ${id} to ${category} in ${course.name}`);
	});

cli_grades
	.command('ignore')
	.description('Exclude imported grades from calculations')
	.argument('<ids...>', 'IDs of the grades, as shown by `eedu grades pull`')
	.option('-u, --undo', 'Include the grades again', false)
	.action((ids, options) => {
		for (const id of ids) grades.setIgnored(id, !options.undo);
	});

cli_grades
	.command('move')
	.description('Move imported grades to another category, where they will stay when pulling')
	.argument('<category>', 'Name of the category, which must already exist')
	.argument('<ids...>', 'IDs of the grades, as shown by `eedu grades pull`')
	.action((category, ids) => grades.move(ids, category));

const cli_category = cli_grades.command('category').description('Manage grade categories');

cli_category
	.command('list')
	.alias('ls')
	.description('List categories')
	.option('-a, --all-terms', 'Include courses from all terms, not just the active ones', false)
	.option('-c, --course <course>', 'Only courses whose ID or name contains this (case insensitive)')
	.action(options => {
		const categories = grades.listAllCategories(options);
		if (!categories.length) {
			console.log('No categories.');
			return;
		}

		io.table(
			[
				{ name: 'Course', text: c => c.course.name },
				{ name: 'Category', text: c => c.name },
				{ name: 'Weight', text: c => percent(c.weight), padStart: true },
				{ name: 'Mode', text: c => c.mode },
				{ name: 'Dropped', text: c => c.dropped || '', padStart: true },
				{ name: 'Grades', text: c => Object.keys(c.scores).length, padStart: true, grow: 0 },
			],
			{ formatHead: text => styleText('bold', text) },
			categories
		);
	});

cli_category
	.command('set')
	.description('Create or change a category')
	.argument('<name>', 'Name of the category')
	.option('-c, --course <course>', 'Course ID or name, supports partial matches and is case insensitive (prompted for if omitted)')
	.option('-w, --weight <weight>', 'Share of the course grade, e.g. 20% or 0.2 (required for new categories)', v =>
		grades.Weight.parse(v)
	)
	.addOption(
		new Option('-m, --mode <mode>', 'How scores are combined: total points, or the average percentage').choices([...grades.Mode.values])
	)
	.option('-d, --dropped <n>', 'Number of lowest scores to drop', v => z.int().nonnegative().parse(Number(v)))
	.action(async (name, { course, ...options }) => grades.setCategory((await grades.resolveCourse(course)).id, name, options));

cli_category
	.command('remove')
	.alias('rm')
	.description('Remove a category without any grades')
	.argument('<name>', 'Name of the category, supports partial matches and is case insensitive')
	.option('-c, --course <course>', 'Course ID or name, supports partial matches and is case insensitive (prompted for if omitted)')
	.action(async (name, options) => {
		const course = await grades.resolveCourse(options.course);
		grades.removeCategory(course.id, grades.findCategory(course, name));
	});
