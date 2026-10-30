import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { Course } from '../../data.js';
import type { toHTML } from '../../text.js';
import { api, apiAll, RequestError } from './api.js';
import type * as types from './types.js';

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
