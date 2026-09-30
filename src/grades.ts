import { Manager } from '@james-pre/config';
import * as io from 'ioium/node';
import { join } from 'node:path';
import { styleText, type InspectColor } from 'node:util';
import * as z from 'zod';
import { dataDir, inProgress, school, type Course } from './data.js';
import { prompt } from './discovery.js';

function parseScore(text: string): number {
	if (text.endsWith('%')) return Number(text.slice(0, -1)) / 100;
	if (!text.includes('/')) return Number(text);
	const [points, total] = text.split('/').map(Number);
	return points / total;
}

/** A percentage, fraction, or decimal */
export const Score = z.union([z.number(), z.string().trim().min(1).transform(parseScore)]).pipe(z.number().nonnegative());

/** A grade imported from a platform */
export const Item = z.object({
	name: z.string(),
	/** Points earned, or null if not graded yet */
	score: z.number().nullable(),
	possible: z.number().nonnegative(),
	ignored: z.boolean().default(false),
});

export interface Item extends z.infer<typeof Item> {}

export const Weight = Score.pipe(z.number().max(1));

export const Category = z.object({
	weight: Weight,
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

export interface CategoryStats extends Category {
	name: string;
	mean: number;
	err: number;
	unknowns: number;
	predicted: number;
	total: number;
}

/** Scores that are ignored or worth no points are not counted. */
function scoresOf(category: Category): (number | null)[] {
	return Object.values(category.scores)
		.filter(item => !item.ignored && item.possible > 0)
		.map(item => (item.score === null ? null : item.score / item.possible));
}

export function categoryStats(name: string, category: Category): CategoryStats {
	const { weight, dropped } = category;
	const scores = scoresOf(category);

	const known = scores.filter(score => score !== null).sort((a, b) => a - b);
	const dropCount = Math.min(dropped, known.length);
	const sum = known.slice(dropCount).reduce((a, b) => a + b, 0);
	const unknowns = scores.length - known.length;
	const total = scores.length - dropCount;

	return {
		...category,
		name,
		mean: (weight * (sum + unknowns / 2)) / total,
		err: (weight * unknowns) / 2 / total,
		predicted: total == unknowns ? 0 : (weight * sum) / (total - unknowns),
		unknowns,
		total,
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
 * Asks for the weight of new categories with graded items when the source doesn't know it,
 * and skips new categories without any.
 * @returns Grades that are new or whose score changed, excluding ignored ones.
 */
export async function pull(sources: GradeSource[], allTerms: boolean = false): Promise<GradeChange[]> {
	const changes: GradeChange[] = [];

	for (const course of school.data.courses) {
		if (!allTerms && !inProgress(course)) continue;

		for (const source of sources) {
			if (!source.has(course)) continue;

			const categories: Record<string, Partial<z.input<typeof Category>>> = {};

			for (const pulled of await source.pull(course)) {
				const local = data.courses[course.id]?.categories[pulled.name];
				const scores: Record<string, z.input<typeof Item>> = {};

				for (const { id: itemId, name, score, possible } of pulled.scores) {
					const id = `${source.name}:${itemId}`;
					const previous = structuredClone(local?.scores[id]);
					if (previous?.name == name && previous.score == score && previous.possible == possible) continue;

					scores[id] = { name, score, possible };
					const changed = previous ? previous.score != score || previous.possible != possible : score !== null;
					if (changed && !previous?.ignored)
						changes.push({ id, course, category: pulled.name, item: { name, score, possible, ignored: false }, previous });
				}

				const category: Partial<z.input<typeof Category>> = {};
				if (Object.keys(scores).length) category.scores = scores;
				if (pulled.dropped !== undefined && pulled.dropped != (local?.dropped ?? 0)) category.dropped = pulled.dropped;

				if (pulled.weight !== undefined && pulled.weight != local?.weight) category.weight = pulled.weight;
				else if (!local && pulled.weight === undefined) {
					if (!pulled.scores.some(item => item.score !== null)) continue;
					category.weight = await askWeight(course, pulled.name);
				}

				if (Object.keys(category).length) categories[pulled.name] = category;
			}

			if (Object.keys(categories).length) store.update({ courses: { [course.id]: { categories } } });
		}
	}

	return changes;
}

/** Find an imported grade by its ID */
export function findItem(id: string): { course: string; category: string; item: Item } | undefined {
	for (const [course, grades] of Object.entries(data.courses)) {
		for (const [category, { scores }] of Object.entries(grades.categories)) {
			if (id in scores) return { course, category, item: scores[id] };
		}
	}
}

export function setIgnored(id: string, ignored: boolean) {
	const found = findItem(id);
	if (!found) throw new Error('No grade with ID ' + id);
	const { course, category } = found;
	store.update({ courses: { [course]: { categories: { [category]: { scores: { [id]: { ignored } } } } } } });
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
				`unweighted ${pce(s.mean / s.weight, s.err / s.weight, true)}` + predict(true),
				s.unknowns && `${s.unknowns} unknown score${s.unknowns != 1 ? 's' : ''}`,
			]
				.filter(x => x)
				.join(', ')
		);
	}
}
