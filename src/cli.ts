import { Command, InvalidArgumentError, Option } from 'commander';
import * as io from 'ioium/node';
import { basename } from 'node:path';
import { styleText, type InspectColor } from 'node:util';
import * as z from 'zod';
import $pkg from '../package.json' with { type: 'json' };
import * as assignments from './assignments.js';
import * as auto from './auto.js';
import * as documents from './documents.js';
import * as labs from './platforms/zybooks/labs.js';
import { config, debugMode } from './config.js';
import { matchCourses, school, type Course } from './data.js';
import { setHandlers } from './discovery.js';
import * as canvas from './platforms/canvas.js';
import * as qemu from './platforms/qemu.js';
import * as zybooks from './platforms/zybooks.js';
import * as grades from './grades.js';
import * as llm from './llm.js';
import type * as canvasTypes from './platforms/canvas.types.js';
import { htmlToText, readText, textFormats, toHTML, type Text } from './text.js';

const cli = new Command('eedu').version($pkg.version).description($pkg.description);

export default cli;

const dim = (text: string) => styleText('dim', text);

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

cli_courses
	.command('info')
	.description('Show a course, its grade thresholds, and categories')
	.argument('[course]', 'Course ID or name, supports partial matches and is case insensitive (prompted for if omitted)')
	.action(async query => {
		const course = await grades.resolveCourse(query);
		const term = school.data.terms.find(t => t.id == course.term);
		const courseGrades = grades.courseGrades(course.id);
		const saved = grades.savedThresholds(course.id);
		const stats = grades.courseStats(courseGrades);

		const out = (key: string, value: string) => console.log(styleText('whiteBright', key + ':'), value);
		const range = (x: number, err: number) => percent(x) + (err ? ' ± ' + percent(err) : '');

		console.log(styleText('bold', `--- ${course.name} ---`));
		out('ID', course.id);
		if (term) out('Term', `${term.name} (${term.start.toLocaleDateString()} to ${term.end.toLocaleDateString()})`);
		else out('Term', course.term);
		if (course.canvas_id !== undefined) out('Canvas ID', course.canvas_id.toString());

		for (const key of ['passing', 'target', 'ideal'] as const) {
			const value = courseGrades[key];
			const text = value === null ? styleText('dim', 'none') : percent(value);
			out(key[0].toUpperCase() + key.slice(1), text + (saved[key] === undefined ? styleText('dim', ' (default)') : ''));
		}

		if (!stats.categories.length) return;

		out('Grade', range(stats.grade, stats.err));
		const totalWeight = stats.categories.reduce((sum, c) => sum + c.weight, 0);
		if (Math.abs(totalWeight - 1) > 1e-9) io.warn(`Category weights add up to ${percent(totalWeight)}`);

		io.table(
			[
				{ name: 'Category', text: c => c.name },
				{ name: 'Weight', text: c => percent(c.weight), padStart: true },
				{ name: 'Mode', text: c => c.mode },
				{ name: 'Grade', text: c => range(c.mean, c.err), padStart: true },
				{ name: 'Unknown', text: c => (c.unknowns ? `${c.unknowns}/${c.total}` : ''), padStart: true, grow: 0 },
			],
			{ formatHead: text => styleText('bold', text) },
			stats.categories
		);
	});

cli_courses
	.command('edit')
	.description("Change a course's grade thresholds")
	.argument('[course]', 'Course ID or name, supports partial matches and is case insensitive (prompted for if omitted)')
	.option('-p, --passing <score>', 'Minimum passing grade, e.g. 60%, or "none"')
	.option('-t, --target <score>', 'Grade you are aiming for, or "none"')
	.option('-i, --ideal <score>', 'Best grade you hope for, or "none"')
	.option('-r, --reset', 'Use the defaults for thresholds that are not given', false)
	.action(async (query, { reset, ...thresholds }) => {
		const course = await grades.resolveCourse(query);
		grades.setThresholds(course.id, grades.Thresholds.parse(thresholds), reset);
	});

const cli_discover = cli.command('discover').description('Discover accounts, courses, etc.');

setHandlers({
	select(question: string, choices: string[], defaultValue?: string): Promise<string> {
		return io.select(question, choices, { default: defaultValue });
	},
	async prompt(question: string, defaultValue: string = ''): Promise<string> {
		if (defaultValue) question += ` [${defaultValue}]`;
		const value = await io.ask(question);
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
	.argument('[books...]', 'ZyBook book codes to auto-complete (prompted for if omitted)')
	.option('--dry-run', 'Do not send completion requests', false)
	.option('-f, --force', 'Force re-completion of already completed activities', false)
	.option(
		'-C, --chapter <n>',
		'Chapter to auto-complete (1-based index), can be given more than once',
		(value, previous: number[] = []) => {
			const chapter = Number(value);
			if (!Number.isSafeInteger(chapter) || chapter <= 0) throw new InvalidArgumentError('Expected a chapter number');
			return [...previous, chapter];
		}
	)
	.option('-S, --section <n>', 'Section to auto-complete (1-based index)', parseInt)
	.option('--show-names', 'Show activity names', false)
	.option('--labs', 'Have Claude work through labs instead of skipping them', false)
	.option('-m, --model <model>', 'Claude model to use for labs, by default ' + config.llm)
	.action(async (books, options) => {
		if (!books.length) {
			if (!zybooks.data.books.length) throw new Error('No books found, run `eedu discover zybooks` first');
			books = [zybooks.data.books.length == 1 ? zybooks.data.books[0] : await io.select('Select a book', zybooks.data.books)];
		}

		for (const book of books) {
			await zybooks.autoComplete(book, {
				...options,
				chapters: options.chapter,
				onComplete(name, resource, part) {
					let text = `${styleText('green', 'Completing')} ${name}`;
					if (typeof part == 'number') text += ` part ${part + 1}/${resource.parts}`;
					console.log(text);
				},
				onSkip(name, resource, reason, show) {
					if (resource.activity_type == 'lab' && !options.labs) {
						console.log(`${styleText('yellow', 'Skipping')} ${name}`);
						io.warnOnce('Labs are skipped. Pass --labs to have Claude work through them.');
						return;
					}
					if (!show && !debugMode) return;
					let text = `${styleText(show ? 'yellow' : 'dim', 'Skipping')} ${name}`;
					if (reason) text += `: ${reason}`;
					console.log(text);
				},
				onLab: options.labs
					? async lab => {
							console.log(`${styleText('green', 'Starting')} ${lab.name}`);
							try {
								const result = await labs.lab(lab, {
									...agentHandlers(),
									model: options.model,
									force: options.force,
									onStatus: text => io.log(dim(text)),
								});
								if (!result.sessionId) return;
								console.log(
									styleText(
										result.points == result.possible ? 'green' : 'yellow',
										`${result.points}/${result.possible} points`
									),
									dim(`estimated cost $${result.cost.toFixed(2)}`)
								);
								if (!result.recorded && result.dir) io.warn(`Nothing was submitted. Claude's work is in ${result.dir}`);
							} catch (e) {
								io.error(`${lab.name} failed: ${io.errorText(e)}`);
							}
						}
					: undefined,
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

/** @param withContext Include the course and category of each grade */
function gradeTable(rows: grades.GradeRow[], withContext: boolean = true) {
	const columns: io.TableColumn<grades.GradeRow>[] = [
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
	];
	io.table(
		columns.filter(c => withContext || (c.name != 'Course' && c.name != 'Category')),
		{ formatHead: text => styleText('bold', text) },
		rows
	);
}

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

		gradeTable(rows);
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

const cli_category = cli_grades
	.command('category')
	.description('Manage grade categories')
	.option('-c, --course <course>', 'Course ID or name, supports partial matches and is case insensitive')
	.configureHelp({ showGlobalOptions: true });

/** The course from `--course`, prompting for one if it's omitted */
function categoryCourse(command: { optsWithGlobals(): { course?: string } }): Promise<Course> {
	return grades.resolveCourse(command.optsWithGlobals().course);
}

cli_category
	.command('list')
	.alias('ls')
	.description('List categories, optionally only those of courses matching --course')
	.option('-a, --all-terms', 'Include courses from all terms, not just the active ones', false)
	.action(async function cli_category_list() {
		const categories = grades.listAllCategories(this.optsWithGlobals());
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
				{ name: 'Expected', text: c => c.expected ?? '', padStart: true },
				{ name: 'Grades', text: c => Object.keys(c.scores).length, padStart: true, grow: 0 },
			],
			{ formatHead: text => styleText('bold', text) },
			categories
		);
	});

cli_category
	.command('info')
	.description('Show a category and its grades')
	.argument('<name>', 'Name of the category, supports partial matches and is case insensitive')
	.action(async function cli_category_info(name) {
		const course = await categoryCourse(this);
		name = grades.findCategory(course, name);
		const category = grades.data.courses[course.id].categories[name];
		const stats = grades.categoryStats(name, category);

		const out = (key: string, value: string) => console.log(styleText('whiteBright', key + ':'), value);
		const range = (x: number, err: number) => percent(x) + (err ? ' ± ' + percent(err) : '');

		console.log(styleText('bold', `--- ${name} (${course.name}) ---`));
		out('Weight', percent(category.weight));
		out('Mode', category.mode);
		if (category.dropped) out('Dropped', category.dropped.toString());
		if (category.expected !== undefined) out('Expected', category.expected.toString());
		out('Grade', range(stats.mean, stats.err) + ' of the course');
		if (category.weight) out('Unweighted', range(stats.mean / category.weight, stats.err / category.weight));
		if (stats.unknowns) out('Unknown', `${stats.unknowns} of ${stats.total}`);

		const rows = grades.categoryGrades(course, name);
		if (rows.length) gradeTable(rows, false);
	});

cli_category
	.command('set')
	.description('Create or change a category')
	.argument('<name>', 'Name of the category')
	.option('-w, --weight <weight>', 'Share of the course grade, e.g. 20% or 0.2 (required for new categories)', v =>
		grades.Weight.parse(v)
	)
	.addOption(
		new Option('-m, --mode <mode>', 'How scores are combined: total points, or the average percentage').choices([...grades.Mode.values])
	)
	.option('-d, --dropped <n>', 'Number of lowest scores to drop', v => z.int().nonnegative().parse(Number(v)))
	.option('-e, --expected <n>', 'Number of assignments the category will have, including ones not posted yet', v =>
		z.int().nonnegative().parse(Number(v))
	)
	.action(async function cli_category_set(name, options) {
		const course = await categoryCourse(this);
		grades.setCategory(course.id, name, options);
	});

cli_category
	.command('remove')
	.alias('rm')
	.description('Remove a category without any grades')
	.argument('<name>', 'Name of the category, supports partial matches and is case insensitive')
	.action(async function cli_category_remove(name) {
		const course = await categoryCourse(this);
		grades.removeCategory(course.id, grades.findCategory(course, name));
	});

const cli_assignments = cli.command('assignments').aliases(['asgn', 'ass']).description('View and submit assignments');

const assignmentSources = [canvas.assignments];

/** A date, or a time relative to now like 3d, -1w, or 12h */
function parseDate(value: string): Date {
	const relative = value.match(/^([+-]?\d+)([hdw])$/);
	if (relative)
		return new Date(Date.now() + Number(relative[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[relative[2] as 'h' | 'd' | 'w']);
	const date = new Date(value);
	if (isNaN(date.getTime())) throw new InvalidArgumentError('Expected a date or a relative time like 3d or 1w');
	return date;
}

const shortDate = (date: Date | string) =>
	new Date(date).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const dueText = (a: assignments.Assignment) => (a.due ? shortDate(a.due) : '');

function dueColor(a: assignments.Assignment): InspectColor | 'reset' {
	if (!a.due || a.status != 'unsubmitted') return 'reset';
	if (a.due.getTime() < Date.now()) return 'redBright';
	return a.due.getTime() - Date.now() < 2 * 86400e3 ? 'yellow' : 'reset';
}

function assignmentStatus(a: assignments.Assignment): string {
	const text = [
		a.status == 'graded' ? styleText('green', 'graded') : a.status == 'submitted' ? styleText('cyan', 'submitted') : '',
		a.missing && styleText('redBright', 'missing'),
		a.late && styleText('yellow', 'late'),
		a.locked && styleText('dim', 'locked'),
	];
	return text.filter(x => x).join(', ');
}

cli_assignments
	.command('list')
	.alias('ls')
	.description('List assignments, by default those due up to 2 weeks from now')
	.option('-a, --all-terms', 'Include courses from all terms, not just the active ones', false)
	.option('-c, --course <course>', 'Only courses whose ID or name contains this (case insensitive)')
	.option('-C, --category <category>', 'Only categories whose name contains this (case insensitive)')
	.option('--since <date>', 'Only assignments due at or after this date, or a relative time like -1w', parseDate)
	.option('--until <date>', 'Only assignments due at or before this date, or a relative time like 3d', parseDate)
	.option('--no-until', 'Include assignments due any time in the future')
	.option('--no-undated', 'Exclude assignments without a due date')
	.addOption(
		new Option('-s, --status <status...>', 'Only assignments with these statuses').choices([
			'unsubmitted',
			'submitted',
			'graded',
		] as const)
	)
	.option('-S, --submittable', 'Only assignments that can be submitted with eedu', false)
	.option('-p, --pending', 'Only assignments that are unsubmitted, unlocked, and accept a submission, including missing ones', false)
	.action(async ({ since, until, ...options }) => {
		const rows = await assignments.listAssignments(assignmentSources, {
			...options,
			after: since,
			before: until === false ? null : until,
		});

		if (!rows.length) {
			console.log('No assignments.');
			return;
		}

		io.table(
			[
				{ name: 'ID', text: a => a.id },
				{ name: 'Course', text: a => a.course.name },
				{ name: 'Category', text: a => a.category ?? '' },
				{ name: 'Name', text: a => a.name },
				{ name: 'Due', text: a => styleText(dueColor(a), dueText(a)) },
				{ name: 'Score', text: a => (a.possible ? `${a.score ?? '?'}/${a.possible}` : ''), padStart: true },
				{ name: 'Status', text: assignmentStatus, grow: 0 },
			],
			{ formatHead: text => styleText('bold', text) },
			rows
		);
	});

/** The assignment with `id`, or the one the user picks from those matching `filter` when it's omitted */
async function resolveAssignment(
	id: string | undefined,
	courseQuery: string | undefined,
	filter: assignments.AssignmentFilter = {}
): Promise<assignments.Assignment> {
	const course = courseQuery ? grades.findCourse(courseQuery) : undefined;
	if (id) return await assignments.getAssignment(assignmentSources, id, course);

	const choices = await assignments.listAssignments(assignmentSources, { ...filter, course: course?.id });
	if (!choices.length) throw new Error('No assignments to choose from');
	return await io.select(
		'Assignment',
		choices.map(a => ({ name: `${a.name} (${a.course.name}${a.due ? ', due ' + dueText(a) : ''})`, value: a }))
	);
}

const assignmentIdHelp = 'Assignment ID, as shown by `eedu assignments list` (prompted for if omitted)';
const courseOptionHelp = 'Course ID or name, supports partial matches and is case insensitive';

const textOption = () => new Option('-t, --text <text>', 'Text to submit');
const textFileOption = () => new Option('-T, --text-file <path>', 'Submit the contents of a text file, or standard input if "-"');
const formatOption = () =>
	new Option('-F, --format <format>', 'Format of the text, by default from the file extension or plain text').choices(textFormats);

/** The text from `--text` or `--text-file`, if either is given */
function textInput(options: { text?: string; textFile?: string; format?: Text['format'] }): Text | undefined {
	if (options.text !== undefined && options.textFile !== undefined) throw new Error('Only one of --text or --text-file can be used');
	if (options.text !== undefined) return { content: options.text, format: options.format ?? 'text' };
	if (options.textFile !== undefined) return readText(options.textFile, options.format);
}

cli_assignments
	.command('info')
	.description('Show an assignment')
	.argument('[id]', assignmentIdHelp)
	.option('-c, --course <course>', courseOptionHelp)
	.action(async (id, options) => {
		const a = await resolveAssignment(id, options.course);
		const out = (key: string, value?: string | false) => value && console.log(styleText('whiteBright', key + ':'), value);
		const time = (date?: Date) => date?.toLocaleString();

		console.log(styleText('bold', `--- ${a.name} (${a.course.name}) ---`));
		out('ID', a.id);
		out('Category', a.category);
		out('Due', a.due && styleText(dueColor(a), dueText(a)));
		out('Available', a.unlock && time(a.unlock));
		out('Until', a.lock && time(a.lock));
		out('Points', a.possible ? `${a.score ?? '?'}/${a.possible}` : '');
		out('Status', assignmentStatus(a) || 'unsubmitted');
		out('Submission', a.types.join(', ') + (a.extensions ? ` (${a.extensions.join(', ')})` : ''));
		out('URL', a.url);
		if (a.description) console.log('\n' + htmlToText(a.description));
	});

/** Placeholders like `[TODO: ...]` in the text and files being sent, labeled by where they are */
async function findPlaceholders(text?: Text, files: string[] = []): Promise<string[]> {
	const found = text ? documents.textPlaceholders(text.content).map(p => 'text: ' + p) : [];
	for (const file of files) for (const p of await documents.placeholders(file)) found.push(`${file}: ${p}`);
	return found;
}

/**
 * Warn about placeholders left in what's being sent, and ask whether to send it anyway.
 * Throws when the user declines, or when confirmation is off and they can't be asked.
 */
async function warnPlaceholders(found: string[], options: { force: boolean; confirm: boolean }) {
	if (options.force || !found.length) return;
	io.warn('This still has placeholders:\n' + found.map(p => '  ' + p).join('\n'));
	if (!options.confirm) throw new Error('Not sent because of the placeholders, use --force to send it anyway');
	if (!(await io.confirm('Send it anyway?', false))) throw new Error('Not sent');
}

const forceHelp = 'Send even if there are placeholders like [TODO: ...]';

cli_assignments
	.command('submit')
	.description('Submit to an assignment')
	.argument('[id]', assignmentIdHelp)
	.option('-c, --course <course>', courseOptionHelp)
	.addOption(textOption())
	.addOption(textFileOption())
	.addOption(formatOption())
	.option('-u, --url <url>', 'Submit a URL')
	.option('-f, --file <paths...>', 'Submit files')
	.option('-m, --comment <text>', 'Add a comment to the submission')
	.option('-y, --no-confirm', 'Do not ask for confirmation')
	.option('--force', forceHelp, false)
	.action(async (id, options) => {
		const text = textInput(options);
		const given = [text, options.url, options.file].filter(x => x !== undefined);
		if (given.length != 1) throw new Error('Exactly one of --text, --text-file, --url, or --file is required');

		const submission: assignments.Submission = text
			? { type: 'text', text }
			: options.url !== undefined
				? { type: 'url', url: options.url }
				: { type: 'file', paths: options.file! };

		const a = await resolveAssignment(id, options.course, { status: ['unsubmitted'], submittable: true });
		assignments.checkSubmission(a, submission);
		await warnPlaceholders(await findPlaceholders(text, options.file), options);
		if (options.confirm) await io.assertYes(`Submit ${submission.type} to ${a.name} in ${a.course.name}`);
		await assignments.submit(assignmentSources, a, submission, { comment: options.comment });
		console.log(styleText('green', 'Submitted'), a.name);
	});

const cli_discussions = cli.command('discussions').alias('disc').description('Read and post in Canvas discussions');

function parseId(value: string): number {
	const id = Number(value.replace(/^#/, ''));
	if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidArgumentError('Expected a numeric ID');
	return id;
}

interface DiscussionRow {
	course: Course;
	topic: canvasTypes.DiscussionTopic;
}

async function listTopics(courses: Course[], options: canvas.DiscussionListOptions & { open?: boolean } = {}): Promise<DiscussionRow[]> {
	const rows: DiscussionRow[] = [];
	for (const course of courses) {
		if (course.canvas_id === undefined) continue;
		for (const topic of await canvas.listDiscussions(course, options)) {
			if (!options.open || !topic.locked_for_user) rows.push({ course, topic });
		}
	}
	return rows;
}

function topicStatus(topic: canvasTypes.DiscussionTopic): string {
	const text = [
		topic.unread_count && styleText('cyan', `${topic.unread_count} unread`),
		!topic.user_can_see_posts && topic.require_initial_post && styleText('yellow', 'post first'),
		topic.locked_for_user && styleText('dim', 'locked'),
	];
	return text.filter(x => x).join(', ');
}

/** The topic with `id`, or the one the user picks when it's omitted */
async function resolveDiscussion(id: number | undefined, courseQuery: string | undefined, open: boolean = false): Promise<DiscussionRow> {
	const courses = courseQuery ? [grades.findCourse(courseQuery)] : matchCourses();

	if (id !== undefined) {
		const found = await canvas.findDiscussion(id, courses);
		if (!found) throw new Error('No discussion with ID ' + id);
		return found;
	}

	const choices = await listTopics(courses, { open });
	if (!choices.length) throw new Error('No discussions to choose from');
	return await io.select(
		'Discussion',
		choices.map(row => ({ name: `${row.topic.title} (${row.course.name})`, value: row }))
	);
}

const topicIdHelp = 'Discussion ID, as shown by `eedu discussions list` (prompted for if omitted)';

cli_discussions
	.command('list')
	.alias('ls')
	.description('List discussions')
	.option('-a, --all-terms', 'Include courses from all terms, not just the active ones', false)
	.option('-c, --course <course>', 'Only courses whose ID or name contains this (case insensitive)')
	.option('-s, --search <text>', 'Only discussions whose title contains this')
	.option('-u, --unread', 'Only discussions with unread entries', false)
	.option('-o, --open', 'Only discussions that are not locked', false)
	.action(async ({ course, allTerms, ...options }) => {
		const rows = await listTopics(matchCourses(course, allTerms), options);
		if (!rows.length) {
			console.log('No discussions.');
			return;
		}

		io.table(
			[
				{ name: 'ID', text: r => r.topic.id },
				{ name: 'Course', text: r => r.course.name },
				{ name: 'Title', text: r => r.topic.title },
				{ name: 'Entries', text: r => r.topic.discussion_subentry_count, padStart: true },
				{ name: 'Last reply', text: r => (r.topic.last_reply_at ? shortDate(r.topic.last_reply_at) : '') },
				{ name: 'Status', text: r => topicStatus(r.topic), grow: 0 },
			],
			{ formatHead: text => styleText('bold', text) },
			rows
		);
	});

cli_discussions
	.command('read')
	.description('Show a discussion and its entries')
	.argument('[id]', topicIdHelp, parseId)
	.option('-c, --course <course>', courseOptionHelp)
	.option('-r, --mark-read', 'Mark the discussion and its entries as read', false)
	.action(async (id, options) => {
		const { course, topic } = await resolveDiscussion(id, options.course);

		console.log(styleText('bold', `--- ${topic.title} (${course.name}) ---`));
		console.log(
			styleText('dim', [topic.user_name, topic.posted_at && shortDate(topic.posted_at), topicStatus(topic)].filter(x => x).join(', '))
		);
		console.log('\n' + htmlToText(topic.message) + '\n');

		let view: canvasTypes.DiscussionView;
		try {
			view = await canvas.viewDiscussion(course, topic.id);
		} catch (e) {
			if (!(e instanceof canvas.RequestError) || e.status != 403) throw e;
			console.log(styleText('yellow', e.message));
			return;
		}

		const names = new Map(view.participants.map(p => [p.id, p.display_name]));
		const unread = new Set(view.unread_entries);

		const printEntry = (entry: canvasTypes.DiscussionViewEntry, depth: number) => {
			const indent = '    '.repeat(depth);
			if (entry.deleted) console.log(indent + styleText('dim', 'Deleted entry'));
			else {
				const author = styleText('bold', names.get(entry.user_id) ?? 'Unknown');
				const meta = styleText('dim', `${shortDate(entry.created_at)} #${entry.id}`);
				console.log(indent + [author, meta, unread.has(entry.id) && styleText('cyan', 'new')].filter(x => x).join(' '));
				for (const line of htmlToText(entry.message ?? '').split('\n')) console.log(indent + '  ' + line);
			}
			console.log();
			for (const reply of entry.replies ?? []) printEntry(reply, depth + 1);
		};

		for (const entry of view.view) printEntry(entry, 0);
		if (!view.view.length) console.log(styleText('dim', 'No entries.'));

		if (options.markRead) await canvas.markRead(course, topic.id);
	});

cli_discussions
	.command('post')
	.description('Post in a discussion, or reply to an entry')
	.argument('[id]', topicIdHelp, parseId)
	.option('-c, --course <course>', courseOptionHelp)
	.option('-r, --reply-to <entry>', 'ID of an entry to reply to, as shown by `eedu discussions read`', parseId)
	.addOption(textOption())
	.addOption(textFileOption())
	.addOption(formatOption())
	.option('-A, --attach <path>', 'Attach a file')
	.option('-y, --no-confirm', 'Do not ask for confirmation')
	.option('--force', forceHelp, false)
	.action(async (id, options) => {
		const text = textInput(options);
		if (!text) throw new Error('One of --text or --text-file is required');

		const { course, topic } = await resolveDiscussion(id, options.course, true);
		if (topic.locked_for_user) throw new Error(topic.title + ' is locked');
		if (options.attach && !topic.permissions.attach) throw new Error(topic.title + ' does not allow attachments');

		await warnPlaceholders(await findPlaceholders(text, options.attach ? [options.attach] : []), options);

		const target = options.replyTo === undefined ? topic.title : `#${options.replyTo} in ${topic.title}`;
		if (options.confirm) await io.assertYes(`${options.replyTo === undefined ? 'Post in' : 'Reply to'} ${target} (${course.name})`);

		const message = toHTML(text);
		const entry =
			options.replyTo === undefined
				? await canvas.postEntry(course, topic.id, message, options.attach)
				: await canvas.replyToEntry(course, topic.id, options.replyTo, message, options.attach);
		console.log(styleText('green', 'Posted'), '#' + entry.id);
	});

async function answerQuestions(questions: llm.Question[]): Promise<Record<string, string>> {
	const answers: Record<string, string> = {};
	const other = '\0other';

	for (const q of questions) {
		const choices = [
			...q.options.map(o => ({ name: `${o.label} ${styleText('dim', o.description)}`, value: o.label })),
			{ name: 'Other (type an answer)', value: other },
		];
		const question = `${styleText('cyan', q.header)} ${q.question}`;
		const picked = q.multiSelect ? await io.multiSelect(question, choices) : [await io.select(question, choices)];
		const typed = picked.includes(other) ? (await io.ask('Your answer: ')).trim() : '';
		answers[q.question] = [...picked.filter(p => p != other), ...(typed ? [typed] : [])].join(', ');
	}

	return answers;
}

function toolSummary(name: string, input: Record<string, unknown>): string {
	const detail = ['file_path', 'path', 'pattern', 'query', 'url', 'id', 'assignment', 'skill', 'vm', 'text']
		.map(key => input[key])
		.find(v => typeof v == 'string');
	const point = typeof input.x == 'number' && typeof input.y == 'number' ? `${input.x},${input.y}` : undefined;
	const keys = Array.isArray(input.keys) ? input.keys.join(' ') : undefined;
	return [name.replace(/^mcp__\w+__/, ''), detail ?? keys ?? point].filter(x => x).join(' ');
}

/** How the CLI answers Claude's questions and asks the student to approve tool calls */
function agentHandlers(course?: Course): Pick<llm.AgentOptions, 'answer' | 'approve' | 'onText' | 'onTool'> {
	const sessionAllowed = new Set<string>();

	return {
		answer: answerQuestions,
		async approve(tool, input) {
			if (sessionAllowed.has(tool)) return true;
			const { question, details } = await approvalPrompt(tool, input, course);
			for (const line of details) io.log(line);

			const forSession = tool != 'Bash' && !tool.startsWith('mcp__');
			const answer = await io.select(question, [
				{ name: 'Yes', value: 'yes' },
				...(forSession ? [{ name: `Yes, and allow ${tool} for the rest of this session`, value: 'session' }] : []),
				{ name: 'No', value: 'no' },
				{ name: 'No, and tell Claude why', value: 'reason' },
			]);

			if (answer == 'session') sessionAllowed.add(tool);
			if (answer == 'reason') {
				const reason = (await io.ask('Why? ')).trim();
				return reason ? { reason } : false;
			}
			return answer == 'yes' || answer == 'session';
		},
		onText: text => io.log(text),
		onTool(name, input) {
			if (name != 'AskUserQuestion' && !name.startsWith('mcp__eedu__')) io.log(dim(toolSummary(name, input)));
		},
	};
}

/** The question and details shown when asking the user to approve a tool call */
async function approvalPrompt(tool: string, input: Record<string, any>, course?: Course): Promise<{ question: string; details: string[] }> {
	const eedu = course && (await auto.describeRequest(assignmentSources, course, tool, input).catch(() => undefined));
	if (eedu) return { question: eedu, details: [] };

	switch (tool) {
		case 'Bash': {
			const command = String(input.command)
				.split('\n')
				.map((line, i) => (i ? '      ' : '    $ ') + line)
				.join('\n');
			return {
				question: 'Run this command?',
				details: [...(input.description ? [styleText('italic', input.description)] : []), command],
			};
		}
		case 'WebFetch': {
			const host = URL.parse(input.url)?.hostname ?? input.url;
			return {
				question: `Fetch a page from ${host}?`,
				details: [styleText('dim', input.url), ...(input.prompt ? [styleText('italic', input.prompt)] : [])],
			};
		}
		case 'Read':
		case 'Write':
		case 'Edit':
			return { question: `${tool} ${input.file_path}?`, details: [] };
		case 'Glob':
		case 'Grep':
			return { question: `Search ${input.path ?? input.pattern}?`, details: [styleText('dim', JSON.stringify(input))] };
		default:
			return { question: `Allow ${tool}?`, details: [styleText('dim', JSON.stringify(input, null, '\t'))] };
	}
}

cli_auto
	.command('assignment')
	.alias('asgn')
	.description('Work on an assignment with Claude')
	.argument('[id]', assignmentIdHelp)
	.option('-c, --course <course>', courseOptionHelp)
	.option('-i, --instructions <text>', 'Extra instructions for Claude')
	.option('-m, --model <model>', 'Claude model to use, by default ' + config.llm)
	.option('-e, --accept-edits', "Use Claude's accept-edits permission mode", false)
	.action(async (id, options) => {
		const a = await resolveAssignment(id, options.course, { pending: true });

		const handlers: Omit<auto.AssignmentOptions, 'instructions' | 'resume'> = {
			...agentHandlers(a.course),
			model: options.model,
			acceptEdits: options.acceptEdits,
			onStatus: text => io.log(dim(text)),
		};

		let result = await auto.assignment(assignmentSources, a, { ...handlers, instructions: options.instructions });
		let submitted = result.submitted;

		for (;;) {
			console.log(styleText('dim', `Files are in ${result.dir} (estimated cost $${result.cost.toFixed(2)})`));
			const feedback = (await io.ask('Changes for Claude (leave empty to finish): ')).trim();
			if (!feedback) break;
			result = await auto.assignment(assignmentSources, a, { ...handlers, resume: result.sessionId, instructions: feedback });
			submitted ||= result.submitted;
		}

		if (submitted) return;

		console.log(
			styleText('yellow', 'Review and edit the assignment before submitting it.'),
			"Check your course's policy on AI use and disclose it as required.",
			'\nThen ask Claude to submit it, or submit it with',
			styleText('cyan', `eedu assignments submit ${a.id} -f <file>`),
			'or',
			styleText('cyan', `-T <file.md>`)
		);
	});
