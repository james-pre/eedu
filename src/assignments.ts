import { extname } from 'node:path';
import { inProgress, school, type Course } from './data.js';
import { findItem } from './grades.js';

export type SubmissionType = 'text' | 'url' | 'file' | 'external' | 'quiz' | 'discussion' | 'media' | 'annotation' | 'paper' | 'none';

/** Submission types that can be submitted with eedu */
export const submittableTypes = ['text', 'url', 'file'] as const satisfies SubmissionType[];

export type Status = 'unsubmitted' | 'submitted' | 'graded';

export interface PulledAssignment {
	/** Unique within the platform */
	id: string;
	name: string;
	/** The platform's category, e.g. a Canvas assignment group */
	category?: string;
	/** HTML */
	description?: string;
	due?: Date;
	unlock?: Date;
	lock?: Date;
	locked: boolean;
	possible: number;
	score: number | null;
	status: Status;
	late: boolean;
	missing: boolean;
	types: SubmissionType[];
	/** File extensions allowed for file submissions, or undefined if any are */
	extensions?: string[];
	url?: string;
}

export interface Assignment extends Omit<PulledAssignment, 'id'> {
	/** `<platform>:<id>`, the same as the ID of its grade */
	id: string;
	course: Course;
}

export type Submission = { type: 'text'; text: string } | { type: 'url'; url: string } | { type: 'file'; paths: string[] };

export interface SubmitOptions {
	comment?: string;
}

/** A platform that assignments can be fetched from and submitted to */
export interface AssignmentSource {
	/** Prefix for assignment IDs */
	name: string;
	has(course: Course): boolean;
	list(course: Course): Promise<PulledAssignment[]>;
	/** @returns Undefined if the course has no assignment with the ID */
	get(course: Course, id: string): Promise<PulledAssignment | undefined>;
	submit(course: Course, id: string, submission: Submission, options: SubmitOptions): Promise<void>;
}

/** Uses the category of the assignment's grade when there is one. */
function resolve(source: AssignmentSource, course: Course, pulled: PulledAssignment): Assignment {
	const id = `${source.name}:${pulled.id}`;
	return { ...pulled, id, course, category: findItem(id, course.id)?.category ?? pulled.category };
}

export function weeksFromNow(weeks: number): Date {
	return new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000);
}

export interface AssignmentFilter {
	/** Only courses whose ID or name contains this (case-insensitive) */
	course?: string;
	/** Only categories whose name contains this (case-insensitive) */
	category?: string;
	allTerms?: boolean;
	/** Only assignments due at or after this */
	after?: Date;
	/** Only assignments due at or before this, defaults to 2 weeks from now; null for no limit */
	before?: Date | null;
	status?: Status[];
	/** Include assignments without a due date, defaults to true */
	undated?: boolean;
	/** Only assignments that can be submitted with eedu */
	submittable?: boolean;
	/** Only assignments that are pending, see {@link isPending} */
	pending?: boolean;
}

function contains(text: string | undefined, query: string): boolean {
	return !!text?.toLowerCase().includes(query.toLowerCase());
}

/** Whether an assignment is unsubmitted, unlocked, and accepts a submission, including missing ones */
export function isPending(assignment: Assignment): boolean {
	return assignment.status == 'unsubmitted' && !assignment.locked && assignment.types.some(t => t != 'none');
}

export function matches(assignment: Assignment, filter: AssignmentFilter): boolean {
	const { due } = assignment;
	const before = filter.before === undefined ? weeksFromNow(2) : filter.before;

	if (filter.category && !contains(assignment.category, filter.category)) return false;
	if (filter.status && !filter.status.includes(assignment.status)) return false;
	if (filter.submittable && (assignment.locked || !canSubmit(assignment))) return false;
	if (filter.pending && !isPending(assignment)) return false;
	if (!due) return filter.undated ?? true;
	if (filter.after && due < filter.after) return false;
	if (before && due > before) return false;
	return true;
}

/** Courses whose ID or name contains `query` (case-insensitive), only those in progress unless `allTerms` is set */
function filterCourses(query?: string, allTerms: boolean = false): Course[] {
	return school.data.courses.filter(c => (!query || contains(c.id, query) || contains(c.name, query)) && (allTerms || inProgress(c)));
}

/** Assignments matching `filter`, sorted by due date with undated ones last */
export async function listAssignments(sources: AssignmentSource[], filter: AssignmentFilter = {}): Promise<Assignment[]> {
	const results: Assignment[] = [];

	for (const course of filterCourses(filter.course, filter.allTerms)) {
		for (const source of sources) {
			if (!source.has(course)) continue;
			for (const pulled of await source.list(course)) {
				const assignment = resolve(source, course, pulled);
				if (matches(assignment, filter)) results.push(assignment);
			}
		}
	}

	return results.sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
}

function sourceOf(sources: AssignmentSource[], id: string): { source: AssignmentSource; localId: string } {
	const [name, ...rest] = id.split(':');
	const source = sources.find(s => s.name == name);
	if (!source || !rest.length) throw new Error(`Invalid assignment ID ${id}, expected <platform>:<id>`);
	return { source, localId: rest.join(':') };
}

/**
 * Get an assignment by its ID.
 * When `course` isn't given, it is found from the assignment's grade or by searching courses in progress.
 */
export async function getAssignment(sources: AssignmentSource[], id: string, course?: Course): Promise<Assignment> {
	const { source, localId } = sourceOf(sources, id);

	const gradeCourse = school.data.courses.find(c => c.id == findItem(id)?.course);
	const candidates = course ? [course] : gradeCourse ? [gradeCourse] : filterCourses();

	for (const course of candidates) {
		if (!source.has(course)) continue;
		const pulled = await source.get(course, localId);
		if (pulled) return resolve(source, course, pulled);
	}

	throw new Error('No assignment with ID ' + id + (course ? ' in ' + course.name : ''));
}

export function canSubmit(assignment: Assignment, type?: Submission['type']): boolean {
	return type ? assignment.types.includes(type) : submittableTypes.some(t => assignment.types.includes(t));
}

/** Throws if the assignment does not accept the submission. */
export function checkSubmission(assignment: Assignment, submission: Submission) {
	if (assignment.locked) throw new Error(assignment.name + ' is locked');
	if (!canSubmit(assignment, submission.type)) {
		const allowed = assignment.types.filter(t => (submittableTypes as readonly SubmissionType[]).includes(t));
		throw new Error(
			`${assignment.name} does not accept ${submission.type} submissions`
				+ (allowed.length ? ', it accepts: ' + allowed.join(', ') : '')
		);
	}

	if (submission.type == 'file' && assignment.extensions?.length) {
		const extensions = assignment.extensions.map(e => e.toLowerCase());
		for (const path of submission.paths) {
			if (!extensions.includes(extname(path).slice(1).toLowerCase()))
				throw new Error(`${path} is not an allowed file type, expected: ` + assignment.extensions.join(', '));
		}
	}
}

/** Submit to an assignment, checking that it accepts the submission first. */
export async function submit(sources: AssignmentSource[], assignment: Assignment, submission: Submission, options: SubmitOptions = {}) {
	const { source, localId } = sourceOf(sources, assignment.id);
	checkSubmission(assignment, submission);
	await source.submit(assignment.course, localId, submission, options);
}
