import { Manager } from '@james-pre/config';
import { join } from 'node:path';
import { styleText, type InspectColor } from 'node:util';
import * as z from 'zod';
import { dataDir, school } from './data.js';

function parseScore(text: string): number {
	if (text.endsWith('%')) return Number(text.slice(0, -1)) / 100;
	if (!text.includes('/')) return Number(text);
	const [points, total] = text.split('/').map(Number);
	return points / total;
}

/** A percentage, fraction, or decimal */
export const Score = z.union([z.number(), z.string().trim().min(1).transform(parseScore)]).pipe(z.number().nonnegative());

export const UnknownScore = z
	.literal('?')
	.nullable()
	.transform(() => null);

export const Category = z.object({
	name: z.string(),
	weight: Score.pipe(z.number().max(1)),
	dropped: z.int().nonnegative().default(0),
	scores: z.union([UnknownScore, Score]).array().default([]),
});

export interface Category extends z.infer<typeof Category> {}

export const CourseGrades = z.object({
	passing: Score.nullable().default(0.6),
	target: Score.nullable().default(0.75),
	ideal: Score.nullable().default(0.9),
	categories: Category.array().default([]),
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
	mean: number;
	err: number;
	unknowns: number;
	predicted: number;
	total: number;
}

export function categoryStats(category: Category): CategoryStats {
	const { scores, weight, dropped } = category;

	const known = scores.filter(score => score !== null).sort((a, b) => a - b);
	const dropCount = Math.min(dropped, known.length);
	const sum = known.slice(dropCount).reduce((a, b) => a + b, 0);
	const unknowns = scores.length - known.length;
	const total = scores.length - dropCount;

	return {
		...category,
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
	const categories = course.categories.map(categoryStats);
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
	const now = new Date();
	const results: GradedCourse[] = [];

	for (const [id, grades] of Object.entries(data.courses)) {
		const course = school.data.courses.find(c => c.id == id);
		const name = course?.name ?? id;

		if (query && ![id, name].some(text => text.toLowerCase().includes(query.toLowerCase()))) continue;

		const term = school.data.terms.find(t => t.id == course?.term);
		if (!allTerms && term && (now < term.start || now > term.end)) continue;

		results.push({ id, name, grades: CourseGrades.parse(grades) });
	}

	return results;
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
