import { Manager } from '@james-pre/config';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';

export const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'eedu');
mkdirSync(dataDir, { recursive: true });

export const Term = z.object({
	id: z.string(),
	name: z.string(),
	start: z.coerce.date(),
	end: z.coerce.date(),
	canvas_id: z.int().optional(),
});

export interface Term extends z.infer<typeof Term> {}

export const Course = z.object({
	id: z.string(),
	name: z.string(),
	term: z.string(),
	canvas_id: z.int().optional(),
});

export interface Course extends z.infer<typeof Course> {}

export const School = z.object({
	terms: Term.array().default([]),
	courses: Course.array().default([]),
});

export interface School extends z.infer<typeof School> {}

export const school = new Manager(School);
school.loadFile(join(dataDir, 'school.json'), { create: true });

/** A short ID like `cs101` from the first course code in `text`, like `CS-101-01`, with `l` appended for labs */
export function courseId(text: string): string | undefined {
	const match = text.match(/\b([A-Z]{2,5})[-_ ]?(\d{3})(?:-([A-Z])?\d+)?/);
	if (!match) return;
	const [, subject, number, section] = match;
	return subject.toLowerCase() + number + (section == 'L' ? 'l' : '');
}

/** `id`, or `id` followed by the term when another course already uses it */
export function uniqueCourseId(id: string, term: string, isSelf: (course: Course) => boolean = () => false): string {
	const taken = (candidate: string) => school.data.courses.some(c => c.id == candidate && !isSelf(c));
	let candidate = id;
	for (let n = 1; taken(candidate); n++) candidate = `${id}-${term}` + (n > 1 ? '-' + n : '');
	return candidate;
}

/** Courses whose ID or name contains `query` (case-insensitive), only those in progress unless `allTerms` is set */
export function matchCourses(query?: string, allTerms: boolean = false): Course[] {
	const q = query?.toLowerCase();
	return school.data.courses.filter(
		c => (!q || c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) && (allTerms || inProgress(c))
	);
}

/** Whether the course's term is in progress, or is unknown. */
export function inProgress(course?: Course): boolean {
	const term = school.data.terms.find(t => t.id == course?.term);
	const now = new Date();
	return !term || (now >= term.start && now <= term.end);
}
