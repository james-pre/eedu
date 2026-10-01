import { Manager } from '@james-pre/config';
import * as io from 'ioium/node';
import { join } from 'node:path';
import { styleText, type InspectColor } from 'node:util';
import * as z from 'zod';
import { dataDir, inProgress, school, type Course } from './data.js';
import { prompt, select } from './discovery.js';

function parseScore(text: string): number {
	if (text.endsWith('%')) return Number(text.slice(0, -1)) / 100;
	if (!text.includes('/')) return Number(text);
	const [points, total] = text.split('/').map(Number);
	return points / total;
}

/** A percentage, fraction, or decimal */
export const Score = z.union([z.number(), z.string().trim().min(1).transform(parseScore)]).pipe(z.number().nonnegative());

/** A grade, either imported from a platform or added by hand */
export const Item = z.object({
	name: z.string(),
	/** Points earned, or null if not graded yet */
	score: z.number().nullable(),
	possible: z.number().nonnegative(),
	ignored: z.boolean().default(false),
	/** Set when the user moved it to another category, so pulling keeps it there */
	moved: z.boolean().default(false),
});

export interface Item extends z.infer<typeof Item> {}

export const Weight = Score.pipe(z.number().max(1));

/**
 * - `points`: points earned over points possible, so larger assignments count more.
 * - `average`: the mean percentage, so every assignment counts equally.
 */
export const Mode = z.literal(['points', 'average']);

export type Mode = z.infer<typeof Mode>;

export const Category = z.object({
	weight: Weight,
	mode: Mode.default('points'),
	dropped: z.int().nonnegative().default(0),
	/** By `<platform>:<id>` */
	scores: z.record(z.string(), Item).default({}),
});

export interface Category extends z.infer<typeof Category> {}

export const CourseGrades = z.object({
	passing: Score.nullable().default(0.6),
	target: Score.nullable().default(0.75),
	ideal: Score.nullable().default(0.9),
	categories: z.record(z.string(), Category).default({}),
});

export interface CourseGrades extends z.infer<typeof CourseGrades> {}

export const Grades = z.object({
	courses: z.record(z.string(), CourseGrades).default({}),
});

export interface Grades extends z.infer<typeof Grades> {}

export const store = new Manager(Grades);
store.loadFile(join(dataDir, 'grades.json'), { create: true });

export const data = store.data;

type SavedGrades = z.output<typeof store.fileSchema>;

/** Modify the saved grades directly, which unlike `store.update` can remove entries. */
function edit(modify: (saved: SavedGrades) => void) {
	const path = store.findPath();
	const saved: SavedGrades = store.configAt(path) ?? {};
	modify(saved);
	store.replaceFile(path, saved as z.input<typeof Grades>);
}

export interface CategoryStats extends Category {
	name: string;
	mean: number;
	err: number;
	unknowns: number;
	predicted: number;
	total: number;
}

/**
 * Scores that are ignored or worth no points are not counted.
 * A category without any counted scores is entirely unknown.
 */
export function categoryStats(name: string, category: Category): CategoryStats {
	const { weight, dropped, mode } = category;

	const scores = Object.values(category.scores)
		.filter(item => !item.ignored && item.possible > 0)
		.map(({ score, possible }) =>
			mode == 'average' ? { score: score === null ? null : score / possible, possible: 1 } : { score, possible }
		);

	const known = scores.filter(s => s.score !== null).sort((a, b) => a.score! / a.possible - b.score! / b.possible);
	const dropCount = Math.min(dropped, known.length);
	const counted = known.slice(dropCount);
	const unknowns = scores.length - known.length;

	const earned = counted.reduce((sum, s) => sum + s.score!, 0);
	const knownPossible = counted.reduce((sum, s) => sum + s.possible, 0);
	const unknownPossible = scores.filter(s => s.score === null).reduce((sum, s) => sum + s.possible, 0);
	const possible = knownPossible + unknownPossible;

	return {
		...category,
		name,
		mean: possible ? (weight * (earned + unknownPossible / 2)) / possible : weight / 2,
		err: possible ? (weight * unknownPossible) / 2 / possible : weight / 2,
		predicted: knownPossible ? (weight * earned) / knownPossible : 0,
		unknowns,
		total: scores.length - dropCount,
	};
}

export interface CourseStats {
	categories: CategoryStats[];
	grade: number;
	err: number;
	predicted: number;
	predictedErr: number;
	fullPrediction: number;
}

export function courseStats(course: CourseGrades): CourseStats {
	const categories = Object.entries(course.categories).map(([name, category]) => categoryStats(name, category));
	const sum = (value: (stats: CategoryStats) => number) => categories.reduce((total, stats) => total + value(stats), 0);

	const predictedErr = sum(s => (s.predicted ? 0 : s.err));
	const predicted = predictedErr + sum(s => s.predicted);

	return {
		categories,
		grade: sum(s => s.mean),
		err: sum(s => s.err),
		predicted,
		predictedErr,
		fullPrediction: sum(s => s.predicted || predicted * s.weight),
	};
}

export interface GradedCourse {
	id: string;
	name: string;
	grades: CourseGrades;
}

/**
 * Courses with grades whose ID or name contains `query` (case-insensitive).
 * Courses in a term that isn't in progress are skipped unless `allTerms` is set.
 */
export function findCourses(query?: string, allTerms: boolean = false): GradedCourse[] {
	const results: GradedCourse[] = [];

	for (const [id, grades] of Object.entries(data.courses)) {
		const course = school.data.courses.find(c => c.id == id);
		const name = course?.name ?? id;

		if (query && ![id, name].some(text => text.toLowerCase().includes(query.toLowerCase()))) continue;
		if (!allTerms && !inProgress(course)) continue;

		results.push({ id, name, grades });
	}

	return results;
}

export interface PulledItem {
	/** Unique within the platform */
	id: string;
	name: string;
	score: number | null;
	possible: number;
}

export interface PulledCategory {
	name: string;
	/** Omitted when the platform doesn't know it */
	weight?: number;
	dropped?: number;
	scores: PulledItem[];
}

/** A platform that grades can be pulled from */
export interface GradeSource {
	/** Prefix for item IDs */
	name: string;
	has(course: Course): boolean;
	pull(course: Course): Promise<PulledCategory[]>;
}

export interface GradeChange {
	id: string;
	course: Course;
	category: string;
	item: Item;
	previous?: Item;
}

async function askWeight(course: Course, category: string): Promise<number> {
	for (;;) {
		const answer = await prompt(`Weight of ${category} in ${course.name}: `);
		const result = Weight.safeParse(answer);
		if (result.success) return result.data;
		io.warn('Invalid weight: ' + z.prettifyError(result.error));
	}
}

/**
 * Pull grades for courses in progress (or all courses when `allTerms` is set) and save them.
 * Asks for the weight of new categories when the source doesn't know it.
 * Grades the user moved stay in their category, others follow the source's category.
 * @returns Grades that are new or whose score changed, excluding ignored ones.
 */
export async function pull(sources: GradeSource[], allTerms: boolean = false): Promise<GradeChange[]> {
	const changes: GradeChange[] = [];

	for (const course of school.data.courses) {
		if (!allTerms && !inProgress(course)) continue;

		for (const source of sources) {
			if (!source.has(course)) continue;

			const categories: Record<string, Partial<z.input<typeof Category>>> = {};
			const patch = (name: string) => (categories[name] ??= {});
			const moves: { id: string; from: string }[] = [];

			for (const pulled of await source.pull(course)) {
				const local = data.courses[course.id]?.categories[pulled.name];
				const meta: Partial<z.input<typeof Category>> = {};

				if (pulled.dropped !== undefined && pulled.dropped != (local?.dropped ?? 0)) meta.dropped = pulled.dropped;

				if (pulled.weight !== undefined && pulled.weight != local?.weight) meta.weight = pulled.weight;
				else if (!local && pulled.weight === undefined) meta.weight = await askWeight(course, pulled.name);

				if (Object.keys(meta).length) Object.assign(patch(pulled.name), meta);

				for (const { id: itemId, name, score, possible } of pulled.scores) {
					const id = `${source.name}:${itemId}`;
					const found = findItem(id, course.id);
					const target = found?.item.moved ? found.category : pulled.name;

					const previous = structuredClone(found?.item);
					const moving = !!found && found.category != target;
					if (!moving && previous?.name == name && previous.score == score && previous.possible == possible) continue;

					(patch(target).scores ??= {})[id] = { name, score, possible, ...(moving && previous?.ignored && { ignored: true }) };
					if (moving) moves.push({ id, from: found.category });

					const changed = previous ? previous.score != score || previous.possible != possible : score !== null;
					const item = { ignored: false, moved: false, ...previous, name, score, possible };
					if (changed && !item.ignored) changes.push({ id, course, category: target, item, previous });
				}
			}

			if (Object.keys(categories).length) store.update({ courses: { [course.id]: { categories } } });

			if (moves.length)
				edit(saved => {
					for (const { id, from } of moves) delete saved.courses?.[course.id]?.categories?.[from]?.scores?.[id];
				});
		}
	}

	return changes;
}

/**
 * The course whose ID or name matches `query` (case-insensitive), preferring exact matches and then courses in progress.
 */
export function findCourse(query: string): Course {
	const q = query.toLowerCase();
	const exact = school.data.courses.find(c => c.id.toLowerCase() == q || c.name.toLowerCase() == q);
	if (exact) return exact;

	let matches = school.data.courses.filter(c => [c.id, c.name].some(text => text.toLowerCase().includes(q)));
	if (matches.length > 1 && matches.some(c => inProgress(c))) matches = matches.filter(c => inProgress(c));
	if (matches.length == 1) return matches[0];

	if (!matches.length) throw new Error('No course matches ' + query);
	throw new Error(`Multiple courses match ${query}:\n` + matches.map(c => '  ' + c.name).join('\n'));
}

/** Find an imported grade by its ID, optionally only in one course */
export function findItem(id: string, courseId?: string): { course: string; category: string; item: Item } | undefined {
	for (const [course, grades] of Object.entries(data.courses)) {
		if (courseId && course != courseId) continue;
		for (const [category, { scores }] of Object.entries(grades.categories)) {
			if (id in scores) return { course, category, item: scores[id] };
		}
	}
}

function getItem(id: string) {
	const found = findItem(id);
	if (!found) throw new Error('No grade with ID ' + id);
	return { id, ...found };
}

export function setIgnored(id: string, ignored: boolean) {
	const { course, category } = getItem(id);
	store.update({ courses: { [course]: { categories: { [category]: { scores: { [id]: { ignored } } } } } } });
}

/** Move imported grades to another category in their course, where pulling will keep them. */
export function move(ids: string[], category: string) {
	const items = ids.map(getItem);

	for (const { course } of items) {
		if (!(category in data.courses[course].categories)) throw new Error(`${course} has no category ${category}`);
	}

	edit(saved => {
		for (const { id, course, category: from } of items) {
			const categories = saved.courses![course]!.categories!;
			const item = categories[from]!.scores![id];
			delete categories[from]!.scores![id];
			((categories[category] ??= {}).scores ??= {})[id] = { ...item, moved: true };
		}
	});
}

export interface CategoryOptions {
	weight?: number;
	mode?: Mode;
	dropped?: number;
}

/** Create or change a category. New categories require a weight. */
export function setCategory(course: string, name: string, options: CategoryOptions) {
	const { weight, mode, dropped } = options;
	if (weight === undefined && !data.courses[course]?.categories[name]) throw new Error('A weight is required for a new category');

	const category: CategoryOptions = {};
	if (weight !== undefined) category.weight = weight;
	if (mode !== undefined) category.mode = mode;
	if (dropped !== undefined) category.dropped = dropped;
	store.update({ courses: { [course]: { categories: { [name]: category } } } });
}

/** Remove a category, which must not have any grades. */
export function removeCategory(course: string, name: string) {
	const category = data.courses[course]?.categories[name];
	if (!category) throw new Error(`${course} has no category ${name}`);
	if (Object.keys(category.scores).length) throw new Error(`${name} still has grades, move them to another category first`);

	edit(saved => {
		delete saved.courses?.[course]?.categories?.[name];
	});
}

/** Points like `8/10`, `?/10` when not graded yet, or a percentage like `85%` */
export const Points = z
	.string()
	.trim()
	.transform((text, ctx) => {
		const percent = text.match(/^([\d.]+)%$/);
		if (percent) return { score: Number(percent[1]), possible: 100 };
		const fraction = text.match(/^(\?|[\d.]+)\/([\d.]+)$/);
		if (fraction) return { score: fraction[1] == '?' ? null : Number(fraction[1]), possible: Number(fraction[2]) };
		ctx.addIssue({ code: 'custom', message: 'Expected points (e.g. 8/10 or ?/10) or a percentage (e.g. 85%)' });
		return z.NEVER;
	})
	.pipe(Item.pick({ score: true, possible: true }));

export type Points = z.infer<typeof Points>;

async function choose<T>(question: string, choices: string[], resolve: (answer: string) => T): Promise<T> {
	for (;;) {
		try {
			return resolve(await select(question, choices));
		} catch (e) {
			io.warn(io.errorText(e));
		}
	}
}

/** The course matching `query`, or the one the user picks from courses in progress when there isn't one. */
export async function resolveCourse(query?: string): Promise<Course> {
	if (query) return findCourse(query);
	const choices = school.data.courses.filter(c => inProgress(c)).map(c => c.name);
	return await choose('Course', choices, findCourse);
}

/** The category of `course` whose name matches `query` (case-insensitive), preferring exact matches. */
export function findCategory(course: Course, query: string): string {
	const names = Object.keys(data.courses[course.id]?.categories ?? {});
	const q = query.toLowerCase();
	const exact = names.find(name => name.toLowerCase() == q);
	if (exact) return exact;

	const matches = names.filter(name => name.toLowerCase().includes(q));
	if (matches.length == 1) return matches[0];
	if (!matches.length) throw new Error(`No category in ${course.name} matches ${query}`);
	throw new Error(`Multiple categories match ${query}: ` + matches.join(', '));
}

/** The category matching `query`, or the one the user picks when there isn't one. */
export async function resolveCategory(course: Course, query?: string): Promise<string> {
	if (query) return findCategory(course, query);
	const names = Object.keys(data.courses[course.id]?.categories ?? {});
	if (!names.length) throw new Error(`${course.name} has no categories, create one with \`eedu grades category set\``);
	return await choose('Category', names, answer => findCategory(course, answer));
}

function nextManualId(): string {
	let max = 0;
	for (const { categories } of Object.values(data.courses)) {
		for (const { scores } of Object.values(categories)) {
			for (const id of Object.keys(scores)) {
				const n = id.match(/^manual:(\d+)$/)?.[1];
				if (n) max = Math.max(max, Number(n));
			}
		}
	}
	return 'manual:' + (max + 1);
}

/**
 * Add a grade by hand. Pulling never changes it.
 * @returns The new grade's ID
 */
export function addGrade(course: string, category: string, name: string, points: Points): string {
	if (!data.courses[course]?.categories[category]) throw new Error(`${course} has no category ${category}`);
	const id = nextManualId();
	store.update({ courses: { [course]: { categories: { [category]: { scores: { [id]: { name, ...points } } } } } } });
	return id;
}

export interface ListOptions {
	course?: string;
	category?: string;
	allTerms?: boolean;
}

export interface GradeRow {
	id: string;
	course: GradedCourse;
	category: string;
	item: Item;
}

/** Grades in courses and categories whose names contain the given filters (case-insensitive). */
export function listGrades(options: ListOptions): GradeRow[] {
	const rows: GradeRow[] = [];
	for (const course of findCourses(options.course, options.allTerms)) {
		for (const { name: category } of listCategories(course, options.category)) {
			for (const [id, item] of Object.entries(course.grades.categories[category].scores)) rows.push({ id, course, category, item });
		}
	}
	return rows;
}

export interface CategoryRow extends Category {
	course: GradedCourse;
	name: string;
}

function listCategories(course: GradedCourse, query?: string): CategoryRow[] {
	return Object.entries(course.grades.categories)
		.filter(([name]) => !query || name.toLowerCase().includes(query.toLowerCase()))
		.map(([name, category]) => ({ ...category, course, name }));
}

/** Categories of courses whose names contain `options.course` (case-insensitive). */
export function listAllCategories(options: Omit<ListOptions, 'category'>): CategoryRow[] {
	return findCourses(options.course, options.allTerms).flatMap(course => listCategories(course));
}

export interface ShowOptions {
	long: boolean;
	predict: boolean;
	predictFullCategory: boolean;
	errorAlignment: number;
}

export function show(name: string, course: CourseGrades, opt: ShowOptions) {
	const { passing, target, ideal } = course;

	const format = (x: number, e: number = 0): InspectColor =>
		!passing && !target && !ideal
			? 'blueBright'
			: passing !== null && x + e < passing
				? 'redBright'
				: ideal && x - e >= ideal
					? 'greenBright'
					: target === null
						? 'blueBright'
						: x >= target
							? 'cyan'
							: 'yellow';
	/** Percentage */
	const pc = (x: number, format: InspectColor = 'blueBright') => styleText(format, (x * 100).toFixed(1).padStart(5)) + '%';
	/** Percentage error */
	const pe = (err: number) => (err ? ' ±' + pc(err) : ' '.repeat(opt.errorAlignment));
	/** Percentage and percentage error */
	const pce = (x: number, e: number, doFormat: boolean = false) => pc(x, doFormat ? format(x, e) : undefined) + pe(e);

	const noPrediction = ' '.repeat(+opt.predict * 19);

	const { categories, grade, err, predicted, predictedErr, fullPrediction } = courseStats(course);

	console.log(styleText('bold', `--- ${name} ---`));

	const out = (k: string, v?: string | false) => v && console.log(styleText('whiteBright', k + ':'), v);

	out('Grade', pce(grade, err, true));

	if (err) {
		if (opt.predict) {
			const full = pc(fullPrediction, 'magenta');
			if (!predicted) out('Prediction', styleText('dim', 'Not available'));
			else if (categories.some(s => s.unknowns != s.total && s.unknowns != 0))
				out('Prediction', pce(predicted, predictedErr, true) + (opt.predictFullCategory ? ` (${full})` : ''));
			else out('Prediction', full);
		}

		out('Minimum', pc(grade - err));
		out('Maximum', pc(grade + err));
	}

	const variable = categories
		.map(s => s.err && pc(s.err * 2) + ' ' + s.name)
		.filter(x => x)
		.join(', ');
	if (variable) out('Variable', variable + '.');

	if (!opt.long) return;

	console.log(styleText('whiteBright', 'Categories:'));
	const nameMax = Math.max(...categories.map(s => s.name.length)) + 1;
	for (const s of categories) {
		const predict = (isUnweighted: boolean = false) => {
			if (!opt.predict || !s.unknowns) return noPrediction;
			const prediction = (s.predicted || predicted * s.weight) / (isUnweighted ? s.weight : 1);
			if (s.predicted) return ` (${pc(prediction, isUnweighted ? format(prediction) : undefined)} predicted)`;
			if (opt.predictFullCategory) return ` (${pc(prediction, 'magenta')} predicted)`;
			return noPrediction;
		};

		console.log(
			[
				`    ${styleText('whiteBright', (s.name + ':').padEnd(nameMax))} ${pce(s.mean, s.err)}` + predict(),
				!!s.weight && `unweighted ${pce(s.mean / s.weight, s.err / s.weight, true)}` + predict(true),
				s.unknowns && `${s.unknowns} unknown score${s.unknowns != 1 ? 's' : ''}`,
			]
				.filter(x => x)
				.join(', ')
		);
	}
}
