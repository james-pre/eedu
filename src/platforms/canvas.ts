import * as z from 'zod';
import $pkg from '../../package.json' with { type: 'json' };
import { Manager } from '@james-pre/config';
import * as io from 'ioium/node';
import { openAsBlob } from 'node:fs';
import { basename, join } from 'node:path';
import type { AssignmentSource, Attachment, PulledAssignment, SubmissionType } from '../assignments.js';
import { courseId, dataDir, school, uniqueCourseId, type Course } from '../data.js';
import { onAdd, prompt, type DiscoverOptions } from '../discovery.js';
import { renameCourse, type GradeSource } from '../grades.js';
import { discover as discoverZybooks } from './zybooks.js';
import { toHTML } from '../text.js';
import { normalizeURL } from '../utils.js';
import type * as types from './canvas.types.js';

export const CanvasData = z
	.object({
		token: z.string(),
		origin: z.url(),
	})
	.partial();

export interface CanvasData extends z.infer<typeof CanvasData> {}

export const store = new Manager(CanvasData);
store.loadFile(join(dataDir, 'canvas.json'), { create: true });

export const data = store.data;

export class TokenError extends Error {
	constructor() {
		super('Canvas access token is invalid or expired, run `eedu discover canvas` to replace it');
	}
}

export class RequestError extends Error {
	constructor(
		message: string,
		public readonly status: number
	) {
		super(message);
	}
}

async function request(method: string, endpoint: string, body?: any, headers: Record<string, string> = {}) {
	if (!data.origin || !data.token) throw new Error('Canvas is not set up, run `eedu discover canvas`');

	const url = new URL(endpoint, data.origin + '/api/v1/');
	const response = await fetch(url, {
		method,
		body: method == 'GET' || method == 'HEAD' ? null : body instanceof FormData ? body : JSON.stringify(body),
		headers: {
			Authorization: `Bearer ${data.token}`,
			'User-Agent': `Mozilla/5.0 (compatible; eedu/${$pkg.version})`,
			...(!(body instanceof FormData) && { 'Content-Type': 'application/json' }),
			...headers,
		},
	});

	if (response.status == 401 && response.headers.has('WWW-Authenticate')) throw new TokenError();

	const text = await response.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		json = { errors: [{ message: text || response.statusText }] };
	}

	if (!response.ok) {
		const [{ message } = {}] = json.errors || [];
		throw new RequestError(message ?? `${method} ${endpoint} failed: ` + response.statusText, response.status);
	}

	return { response, json };
}

export async function api<T = any>(method: string, endpoint: string, body?: any, headers: Record<string, string> = {}): Promise<T> {
	const { json } = await request(method, endpoint, body, headers);
	return json;
}

/** GET every page of a list endpoint */
export async function apiAll<T>(endpoint: string): Promise<T[]> {
	const results: T[] = [];
	let next: string | undefined = endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100';
	while (next) {
		const { response, json } = await request('GET', next);
		results.push(...json);
		next = response.headers.get('Link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
	}
	return results;
}

export async function discover(options: DiscoverOptions) {
	if (!data.origin) {
		const domain = await prompt('Enter the Canvas instance domain: ');
		data.origin = normalizeURL(domain).origin;
	}

	if (data.token) {
		try {
			await api('GET', 'users/self');
		} catch (e) {
			if (!(e instanceof TokenError)) throw e;
			io.warn('Your Canvas access token is invalid or expired.');
			data.token = undefined;
		}
	}

	if (!data.token) {
		/**
		 * @todo use OAuth2 because Canvas access tokens because according to the API docs:
		 * > Note that asking any other user to manually generate a token and enter it into your application is a violation of Canvas' API Policy.
		 * > Applications in use by multiple users MUST use OAuth to obtain tokens.
		 */
		const token = await prompt(`Enter your access token from ${data.origin}/profile/settings#access_tokens_holder: `);
		data.token = token.trim();
	}

	store.update({ origin: data.origin, token: data.token });

	for (const course of await apiAll<types.Course>('courses?include[]=term')) {
		if (course.access_restricted_by_date) continue;

		const existing_term = school.data.terms.find(t => t.canvas_id == course.term.id);

		const term_id = course.term.name.replace(/\s+/g, '_').toLowerCase();

		if (course.term && !existing_term) {
			school.data.terms.push({
				id: term_id,
				name: course.term.name,
				start: new Date(course.term.start_at),
				end: new Date(course.term.end_at),
				canvas_id: course.term.id,
			});
			onAdd('term', course.term.name);
		}

		const existing = school.data.courses.find(c => c.canvas_id == course.id);
		const fallback = course.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
		const id = uniqueCourseId(
			courseId(course.name) ?? courseId(course.course_code) ?? fallback,
			term_id,
			c => c.canvas_id == course.id
		);

		if (existing && existing.id == course.course_code && existing.id != id) {
			renameCourse(existing.id, id);
			io.info(`Renamed course ${existing.id} to ${id}`);
			existing.id = id;
		}

		if (!existing) {
			school.data.courses.push({
				id,
				name: course.name,
				term: term_id,
				canvas_id: course.id,
			});
			onAdd('course', course.name);
		}

		if (!options.recursive) continue;

		const modules = await apiAll<types.Module>(`courses/${course.id}/modules?include[]=items`);

		for (const module of modules) {
			module.items ||= await apiAll<types.ModuleItem>(module.items_url);
			for (const item of module.items) {
				if (item.type != 'ExternalTool') continue;

				const { hostname } = new URL(item.external_url!);
				if (hostname.endsWith('.zybooks.com')) {
					console.log('\tZyBook:', module.name, '->', item.title);
					await discoverZybooks();
				}
			}
		}
	}

	school.update({ terms: school.data.terms, courses: school.data.courses });
}

interface AssignmentGroup extends Omit<types.AssignmentGroup, 'assignments'> {
	assignments: types.Assignment[];
}

function assignmentGroups(course: Course): Promise<AssignmentGroup[]> {
	return apiAll<AssignmentGroup>(`courses/${course.canvas_id}/assignment_groups?include[]=assignments&include[]=submission`);
}

export const grades: GradeSource = {
	name: 'canvas',
	has: course => course.canvas_id !== undefined,
	async pull(course) {
		const { apply_assignment_group_weights } = await api<types.Course>('GET', `courses/${course.canvas_id}`);
		const groups = await assignmentGroups(course);

		return groups.map(group => ({
			name: group.name,
			weight: apply_assignment_group_weights ? group.group_weight / 100 : undefined,
			dropped: group.rules?.drop_lowest ?? 0,
			scores: group.assignments
				.filter(a => !a.omit_from_final_grade && a.grading_type != 'not_graded' && !a.submission?.excused)
				.map(a => ({ id: String(a.id), name: a.name, score: a.submission?.score ?? null, possible: a.points_possible ?? 0 })),
		}));
	},
};

const submissionTypes: Record<types.Assignment['submission_types'][number], SubmissionType> = {
	online_text_entry: 'text',
	online_url: 'url',
	online_upload: 'file',
	external_tool: 'external',
	online_quiz: 'quiz',
	discussion_topic: 'discussion',
	media_recording: 'media',
	student_annotation: 'annotation',
	on_paper: 'paper',
	none: 'none',
	not_graded: 'none',
};

const date = (value?: string | null) => (value ? new Date(value) : undefined);

function toPulled(assignment: types.Assignment, category?: string): PulledAssignment {
	const { submission } = assignment;
	const state = submission?.workflow_state;
	return {
		id: String(assignment.id),
		name: assignment.name,
		category,
		description: assignment.description || undefined,
		due: date(assignment.due_at),
		unlock: date(assignment.unlock_at),
		lock: date(assignment.lock_at),
		locked: assignment.locked_for_user,
		possible: assignment.points_possible ?? 0,
		score: submission?.score ?? null,
		status: state == 'graded' ? 'graded' : state == 'submitted' || state == 'pending_review' ? 'submitted' : 'unsubmitted',
		late: !!submission?.late,
		missing: !!submission?.missing,
		types: [...new Set(assignment.submission_types.map(t => submissionTypes[t]))],
		extensions: assignment.allowed_extensions?.length ? assignment.allowed_extensions : undefined,
		url: assignment.html_url,
	};
}

interface UploadTarget {
	upload_url: string;
	upload_params: Record<string, string>;
}

/**
 * Upload a file using Canvas' file upload process.
 * @returns The ID of the uploaded file
 */
async function upload(endpoint: string, path: string): Promise<number> {
	const file = await openAsBlob(path);
	const name = basename(path);
	const { upload_url, upload_params } = await api<UploadTarget>('POST', endpoint, { name, size: file.size });

	const form = new FormData();
	for (const [key, value] of Object.entries(upload_params)) form.append(key, value);
	form.append('file', file, name);

	const response = await fetch(upload_url, { method: 'POST', body: form, redirect: 'manual' });
	const location = response.headers.get('Location');
	if (location && (response.status == 201 || (response.status >= 300 && response.status < 400)))
		return (await api<{ id: number }>('GET', location)).id;
	if (!response.ok) throw new Error(`Uploading ${name} failed: ` + response.statusText);
	return ((await response.json()) as { id: number }).id;
}

interface CanvasFile {
	id: number;
	display_name: string;
	url: string;
}

/** Files linked from HTML, such as an assignment description */
export async function linkedFiles(course: Course, html: string): Promise<Attachment[]> {
	const ids = new Set([...html.matchAll(/\/files\/(\d+)/g)].map(m => m[1]));
	const files = await Promise.all([...ids].map(id => api<CanvasFile>('GET', `courses/${course.canvas_id}/files/${id}`)));
	return files.map(file => ({
		name: file.display_name,
		async download() {
			const response = await fetch(file.url, { headers: { Authorization: `Bearer ${data.token}` } });
			if (!response.ok) throw new Error(`Downloading ${file.display_name} failed: ` + response.statusText);
			return new Uint8Array(await response.arrayBuffer());
		},
	}));
}

export const assignments: AssignmentSource = {
	name: 'canvas',
	has: course => course.canvas_id !== undefined,
	async list(course) {
		const groups = await assignmentGroups(course);
		return groups.flatMap(group => group.assignments.map(a => toPulled(a, group.name)));
	},
	async get(course, id) {
		try {
			const assignment = await api<types.Assignment>('GET', `courses/${course.canvas_id}/assignments/${id}?include[]=submission`);
			const group = await api<types.AssignmentGroup>(
				'GET',
				`courses/${course.canvas_id}/assignment_groups/${assignment.assignment_group_id}`
			);
			return toPulled(assignment, group.name);
		} catch (e) {
			if (e instanceof RequestError && e.status == 404) return;
			throw e;
		}
	},
	async attachments(course, id) {
		const assignment = await api<types.Assignment>('GET', `courses/${course.canvas_id}/assignments/${id}`);
		return linkedFiles(course, assignment.description ?? '');
	},
	async submit(course, id, submission, { comment }) {
		const endpoint = `courses/${course.canvas_id}/assignments/${id}/submissions`;

		const topic = submission.type == 'text' && (await assignmentDiscussion(course, Number(id)));
		if (topic) {
			if (comment) throw new Error('Comments are not supported for discussion posts');
			await postEntry(course, topic.id, toHTML(submission.text));
			return;
		}

		const body =
			submission.type == 'text'
				? { submission_type: 'online_text_entry', body: toHTML(submission.text) }
				: submission.type == 'url'
					? { submission_type: 'online_url', url: submission.url }
					: {
							submission_type: 'online_upload',
							file_ids: await Promise.all(submission.paths.map(path => upload(endpoint + '/self/files', path))),
						};

		await api('POST', endpoint, { submission: body, ...(comment && { comment: { text_comment: comment } }) });
	},
};

let userGroups: Promise<number[]> | undefined;

/** IDs of the groups the user is in */
function groups(): Promise<number[]> {
	return (userGroups ??= apiAll<{ id: number }>('users/self/groups').then(groups => groups.map(group => group.id)));
}

const topicEndpoints = new Map<string, Promise<string>>();

/** The API path of a topic, which for a group discussion is the user's group's copy of it */
function topicEndpoint(course: Course, topic: number): Promise<string> {
	const base = `courses/${course.canvas_id}/discussion_topics/${topic}`;
	let endpoint = topicEndpoints.get(base);
	if (endpoint) return endpoint;

	endpoint = (async () => {
		const { title, group_topic_children } = await api<types.DiscussionTopic>('GET', base);
		if (!group_topic_children?.length) return base;
		const mine = await groups();
		const child = group_topic_children.find(child => mine.includes(child.group_id));
		if (!child) throw new Error(`${title} is a group discussion, and you aren't in any of its groups`);
		return `groups/${child.group_id}/discussion_topics/${child.id}`;
	})();
	endpoint.catch(() => topicEndpoints.delete(base));
	topicEndpoints.set(base, endpoint);
	return endpoint;
}

export interface DiscussionListOptions {
	/** Only topics whose title contains this */
	search?: string;
	/** Only topics with unread entries */
	unread?: boolean;
	/** Only announcements instead of only discussions */
	announcements?: boolean;
}

export function listDiscussions(course: Course, options: DiscussionListOptions = {}): Promise<types.DiscussionTopic[]> {
	const params = new URLSearchParams();
	if (options.search) params.set('search_term', options.search);
	if (options.unread) params.set('filter_by', 'unread');
	if (options.announcements) params.set('only_announcements', 'true');
	return apiAll(`courses/${course.canvas_id}/discussion_topics` + (params.size ? '?' + params : ''));
}

/** A topic, which for a group discussion is the user's group's copy with the course topic's ID */
export async function getDiscussion(course: Course, topic: number): Promise<types.DiscussionTopic> {
	return { ...(await api<types.DiscussionTopic>('GET', await topicEndpoint(course, topic))), id: topic };
}

/** Find a topic by searching `courses` */
export async function findDiscussion(
	topic: number,
	courses: Course[]
): Promise<{ course: Course; topic: types.DiscussionTopic } | undefined> {
	for (const course of courses) {
		if (course.canvas_id === undefined) continue;
		try {
			return { course, topic: await getDiscussion(course, topic) };
		} catch (e) {
			if (!(e instanceof RequestError) || e.status != 404) throw e;
		}
	}
}

/** The topic of a discussion assignment, or undefined for other assignments */
export async function assignmentDiscussion(course: Course, assignment: number): Promise<types.DiscussionTopic | undefined> {
	const { discussion_topic } = await api<types.Assignment>('GET', `courses/${course.canvas_id}/assignments/${assignment}`);
	return discussion_topic;
}

/** Throws a clearer error when the topic requires posting before seeing other entries, see `user_can_see_posts` */
async function readEntries<T>(fetchEntries: Promise<T>): Promise<T> {
	try {
		return await fetchEntries;
	} catch (e) {
		if (!(e instanceof RequestError) || e.message != 'require_initial_post') throw e;
		throw new RequestError('This discussion requires posting before seeing other entries', e.status);
	}
}

/** Every entry of a topic with replies nested, including `new_entries`, and the participants who wrote them */
export async function viewDiscussion(course: Course, topic: number): Promise<types.DiscussionView> {
	const view = await readEntries(api<types.DiscussionView>('GET', (await topicEndpoint(course, topic)) + '/view'));

	const entries = new Map<number, types.DiscussionViewEntry>();
	const index = (list: types.DiscussionViewEntry[]) => {
		for (const entry of list) {
			entries.set(entry.id, entry);
			index(entry.replies ?? []);
		}
	};
	index(view.view);

	for (const entry of view.new_entries ?? []) {
		if (entries.has(entry.id)) continue;
		entries.set(entry.id, entry);
		const parent = entry.parent_id === null ? undefined : entries.get(entry.parent_id);
		(parent ? (parent.replies ??= []) : view.view).push(entry);
	}

	return view;
}

/** Top-level entries, newest first */
export async function listEntries(course: Course, topic: number): Promise<types.DiscussionEntry[]> {
	return readEntries(apiAll((await topicEndpoint(course, topic)) + '/entries'));
}

/** Replies to an entry, newest first */
export async function listReplies(course: Course, topic: number, entry: number): Promise<types.DiscussionEntry[]> {
	return readEntries(apiAll((await topicEndpoint(course, topic)) + `/entries/${entry}/replies`));
}

async function postMessage(endpoint: string, message: string, attachment?: string): Promise<types.DiscussionEntry> {
	if (!attachment) return await api('POST', endpoint, { message });
	const form = new FormData();
	form.append('message', message);
	form.append('attachment', await openAsBlob(attachment), basename(attachment));
	return await api('POST', endpoint, form);
}

/**
 * Post a top-level entry.
 * @param message HTML, see {@link toHTML}
 * @param attachment Path of a file to attach
 */
export async function postEntry(course: Course, topic: number, message: string, attachment?: string): Promise<types.DiscussionEntry> {
	return postMessage((await topicEndpoint(course, topic)) + '/entries', message, attachment);
}

/**
 * Reply to an entry.
 * @param message HTML, see {@link toHTML}
 * @param attachment Path of a file to attach
 */
export async function replyToEntry(
	course: Course,
	topic: number,
	entry: number,
	message: string,
	attachment?: string
): Promise<types.DiscussionEntry> {
	return postMessage((await topicEndpoint(course, topic)) + `/entries/${entry}/replies`, message, attachment);
}

/** @param message HTML, see {@link toHTML} */
export async function editEntry(course: Course, topic: number, entry: number, message: string): Promise<types.DiscussionEntry> {
	return api('PUT', (await topicEndpoint(course, topic)) + `/entries/${entry}`, { message });
}

export async function deleteEntry(course: Course, topic: number, entry: number): Promise<void> {
	await api('DELETE', (await topicEndpoint(course, topic)) + `/entries/${entry}`);
}

/** Mark one entry as read, or the topic and all of its entries when `entry` is omitted */
export async function markRead(course: Course, topic: number, entry?: number): Promise<void> {
	await api('PUT', (await topicEndpoint(course, topic)) + (entry === undefined ? '/read_all' : `/entries/${entry}/read`));
}
