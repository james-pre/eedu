import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import * as z from 'zod';
import $pkg from '../package.json' with { type: 'json' };
import type { AssignmentSource } from './assignments.js';
import { courseDir, courseNotes, data as autoData, eeduTools, studentProfile, type ToolEvents } from './auto.js';
import type { Course } from './data.js';
import * as grades from './grades.js';
import { pluginDir, prompt, runAgent, type AgentOptions, type AgentResult } from './llm.js';

const textResult = (text: string, isError: boolean = false) => ({ content: [{ type: 'text' as const, text }], isError });

const readOnly = { annotations: { readOnlyHint: true } };

/** The course tools used to read about the course, which leaves out anything that submits */
const courseTools = ['get_course', 'get_assignment', 'download_attachments', 'read_syllabus', 'read_document', 'render_document'];

const percent = (x: number) => +(x * 100).toFixed(2) + '%';

function gradesText(course: Course, pulled: grades.PulledCategory[]): string {
	const { passing, categories } = grades.courseGrades(course.id);
	const lines = [`# Grades in ${course.name}`, '', 'Passing grade: ' + (passing === null ? 'none' : percent(passing))];

	const weights = Object.values(categories).map(category => category.weight);
	const total = weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0);
	lines.push(
		`Weights add up to ${percent(total)}`
			+ (weights.includes(undefined) ? `, with ${weights.filter(w => w === undefined).length} unknown` : '')
	);

	for (const [name, category] of Object.entries(categories)) {
		const details = [
			'weight ' + (category.weight === undefined ? 'unknown' : percent(category.weight)),
			category.mode,
			category.dropped && `${category.dropped} dropped`,
			category.expected !== undefined && `${category.expected} expected`,
			category.edited && 'weight and dropped count edited by hand',
		];
		lines.push('', `## ${name}`, details.filter(x => x).join(', '));
		for (const [id, item] of Object.entries(category.scores)) {
			const flags = [item.ignored && 'ignored', item.moved && 'moved here by hand', !item.possible && 'worth no points'].filter(
				x => x
			);
			lines.push(`- ${id} ${item.name}: ${item.score ?? '?'}/${item.possible}` + (flags.length ? ` (${flags.join(', ')})` : ''));
		}
		if (!Object.keys(category.scores).length) lines.push('No grades');
	}

	lines.push('', '# What the LMS reports', '');
	if (!pulled.length) lines.push('Nothing, the course has no LMS with grades.');
	for (const category of pulled) {
		const details = [
			category.weight === undefined ? "doesn't give a weight" : 'weight ' + percent(category.weight),
			category.dropped && `${category.dropped} dropped`,
			`${category.scores.length} assignments`,
		];
		lines.push(`- ${category.name}: ${details.filter(x => x).join(', ')}`);
	}

	return lines.join('\n');
}

/** Tools for reading and changing one course's grade setup through eedu */
export function gradeTools(course: Course, pulled: grades.PulledCategory[], events: ToolEvents = {}) {
	const status = (text: string) => events.onStatus?.(text);
	const attempt = (change: () => string) => {
		try {
			const text = change();
			status(text);
			return textResult(text);
		} catch (e) {
			return textResult(e instanceof Error ? e.message : String(e), true);
		}
	};
	const category = (name: string) => grades.findCategory(course, name);
	const reason = z.string().describe('Why, citing the syllabus, the LMS, or the student');

	return [
		tool(
			'get_grades',
			"Get the course's grade setup in eedu: the passing grade, each category's weight, mode, dropped and expected counts, and every grade with its ID, followed by what the LMS reports",
			{},
			async () => textResult(gradesText(course, pulled)),
			readOnly
		),

		tool(
			'set_category',
			"Create a category or change one. Setting the weight or dropped count keeps it from being replaced by the LMS's when pulling.",
			{
				name: z.string(),
				weight: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.describe('Share of the course grade, e.g. 0.2 for 20%; required for new categories'),
				mode: grades.Mode.optional().describe('points: total points earned over possible; average: mean percentage'),
				dropped: z.number().int().nonnegative().optional().describe('Number of lowest scores dropped'),
				expected: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe('Number of assignments the category will have in total, including ones not posted yet'),
				reason,
			},
			async ({ name, reason, ...options }) =>
				attempt(() => {
					const saved = grades.setCategory(course.id, name, options);
					const changes = Object.entries(options)
						.filter(([, value]) => value !== undefined)
						.map(([key, value]) => `${key} ${key == 'weight' ? percent(value as number) : value}`);
					return `Set ${saved}: ${changes.join(', ') || 'no changes'} (${reason})`;
				})
		),

		tool(
			'remove_category',
			'Remove a category that has no grades; move or remove its grades first',
			{ name: z.string(), reason },
			async ({ name, reason }) =>
				attempt(() => {
					const found = category(name);
					grades.removeCategory(course.id, found);
					return `Removed ${found} (${reason})`;
				})
		),

		tool(
			'move_grades',
			'Move grades to another category of the course, where pulling keeps them',
			{ ids: z.string().array().min(1), category: z.string(), reason },
			async ({ ids, category: name, reason }) =>
				attempt(() => {
					const found = category(name);
					grades.move(ids, found);
					return `Moved ${ids.join(', ')} to ${found} (${reason})`;
				})
		),

		tool(
			'ignore_grades',
			"Exclude grades that shouldn't count toward the course grade, or include them again",
			{ ids: z.string().array().min(1), ignored: z.boolean(), reason },
			async ({ ids, ignored, reason }) =>
				attempt(() => {
					for (const id of ids) grades.setIgnored(id, ignored);
					return `${ignored ? 'Ignored' : 'Included'} ${ids.join(', ')} (${reason})`;
				})
		),

		tool(
			'add_grade',
			"Add a grade the LMS doesn't have, such as an exam graded on paper. Use a category's expected count instead for assignments the LMS will post later.",
			{
				category: z.string(),
				name: z.string(),
				score: z.number().nonnegative().nullable().describe('Points earned, or null if not graded yet'),
				possible: z.number().nonnegative(),
				reason,
			},
			async ({ category: name, name: itemName, score, possible, reason }) =>
				attempt(() => {
					const found = category(name);
					const id = grades.addGrade(course.id, found, itemName, { score, possible });
					return `Added ${id} ${itemName} (${score ?? '?'}/${possible}) to ${found} (${reason})`;
				})
		),

		tool(
			'remove_grade',
			'Remove a grade that was added by hand; ignore grades from the LMS instead',
			{ id: z.string(), reason },
			async ({ id, reason }) =>
				attempt(() => {
					grades.removeGrade(id);
					return `Removed ${id} (${reason})`;
				})
		),

		tool(
			'set_passing',
			"Set the lowest passing course grade from the syllabus' grading scale",
			{ passing: z.number().min(0).max(1).nullable().describe('e.g. 0.6 for 60%, or null if the course has none'), reason },
			async ({ passing, reason }) =>
				attempt(() => {
					grades.setThresholds(course.id, { passing });
					return `Set the passing grade to ${passing === null ? 'none' : percent(passing)} (${reason})`;
				})
		),
	];
}

export interface DoctorOptions extends Omit<AgentOptions, 'dir' | 'readable' | 'writable' | 'mcpServers' | 'allowedTools' | 'askTools'> {
	/** What the course's platforms reported when pulling */
	pulled: grades.PulledCategory[];
	/** Extra instructions from the student, or their feedback when continuing a session */
	instructions?: string;
	onStatus?: ToolEvents['onStatus'];
}

/**
 * Have Claude check a course's grade setup against its syllabus and LMS, and fill in or correct it through eedu.
 * Claude can only write in the course's directory and to the student profile.
 */
export async function doctor(sources: AssignmentSource[], course: Course, options: DoctorOptions): Promise<AgentResult> {
	const dir = courseDir(course);
	mkdirSync(dir, { recursive: true });

	const events = { onStatus: options.onStatus };
	const tools = [
		...eeduTools(sources, course, events).filter(t => courseTools.includes(t.name)),
		...gradeTools(course, options.pulled, events),
	];

	const text = options.resume
		? (options.instructions ?? '')
		: prompt('grades-doctor', {
				course: course.name,
				dir,
				notes: courseNotes(course),
				profile: studentProfile(),
				instructions: options.instructions ? "The student's instructions:\n" + options.instructions : '',
			});

	return await runAgent(text, {
		...options,
		dir,
		readable: [autoData.dir, pluginDir],
		writable: [studentProfile()],
		mcpServers: { eedu: createSdkMcpServer({ name: 'eedu', version: $pkg.version, tools }) },
		allowedTools: tools.map(t => 'mcp__eedu__' + t.name),
	});
}
