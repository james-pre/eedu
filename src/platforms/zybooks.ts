import { createHash } from 'node:crypto';
import * as z from 'zod';
import $pkg from '../../package.json' with { type: 'json' };
import { Manager } from '@james-pre/config';
import { join } from 'node:path';
import { dataDir } from '../data.js';
import { onAdd, prompt } from '../discovery.js';

export const ZybooksData = z.object({
	token: z.string().nullish(),
	user_id: z.int().optional(),
	books: z.string().array().default([]),
	completed_resources: z.int().array().default([]),
});

export interface ZybooksData extends z.infer<typeof ZybooksData> {}

export const store = new Manager(ZybooksData);
store.loadFile(join(dataDir, 'zybooks.json'), { create: true });

export const data = store.data;

async function request<T>(base: string, method: string, endpoint: string, body?: any, headers: Record<string, string> = {}): Promise<T> {
	const url = new URL(endpoint, base);
	const response = await fetch(url, {
		method,
		body: method == 'GET' || method == 'HEAD' ? null : JSON.stringify(body),
		headers: {
			Authorization: `Bearer ${data.token}`,
			'User-Agent': `Mozilla/5.0 (compatible; eedu/${$pkg.version})`,
			Accept: 'application/json',
			...headers,
		},
	});

	const json: any = await response
		.json()
		.catch(() => ({ success: false, error: { message: `${method} ${endpoint} failed: ` + response.statusText } }));

	if (!response.ok || !json.success) {
		const { message } = json.error || {};
		throw new Error(message ?? `${method} ${endpoint} failed: ` + response.statusText);
	}

	return json;
}

export function api<T = any>(method: string, endpoint: string, body?: any, headers: Record<string, string> = {}): Promise<T> {
	return request<T>('https://zyserver.zybooks.com/v1/', method, endpoint, body, headers);
}

/** The server behind IT labs, which runs their VMs and grades them. It rejects a content type without a body. */
function itlabs<T = any>(method: string, endpoint: string, body?: any): Promise<T> {
	const headers: Record<string, string> = body === undefined ? {} : { 'Content-Type': 'application/json' };
	return request<T>('https://itlabs-server.zybooks.com/v1/', method, endpoint, body, headers);
}

export interface Chapter {
	sections: ChapterSection[];
	title: string;
	number: number;
}

export interface ChapterSection {
	title: string;
	short_title: string;
	canonical_section_id: number;
	canonical_zybook_id: number;
	canonical_chapter_number: number;
	canonical_section_number: number;
	subject_id: number;
	subject_label: string;
	version: string;
	release_id: number;
	optional: boolean;
	hidden: boolean;
	type: string;
	subject_name: string;
	number: number;
	new: boolean;
}

export interface Section extends ChapterSection {
	content_resources: ContentResource[];
}

export interface ContentResource {
	id: number;
	caption?: string;
	payload: Payload;
	/** Markdown for IT labs */
	instructions?: string | unknown[];
	parts: number;
	activity_type?: string;
	type: string;
	guid?: string;
	release_id: number;
	optional: boolean;
	_number: number;
}

export interface Payload {
	subject: string;
	image_ids: string[];
	tool?: string;
	size: any;
	questions: Question[];
	/** Instructions, steps, and graded goals, for IT labs */
	items?: LabItem[];
	/** The VMs an IT lab runs on */
	vmImages?: VmImage[];
	/** What a programming lab's code is graded against */
	testCases?: TestCase[];
}

/** One run of a programming lab's code, with the output it is expected to produce */
export interface TestCase {
	id: string;
	title: string;
	type: string;
	points: number;
	stdin: string;
	stdout: string;
	argStr: string;
	sourceFile: string;
	hidden: boolean;
	sortWeight: number;
	stdoutCompareMethod: string;
	stdoutCompareOptions: { ignoreCase: boolean; ignoreWhitespace: boolean };
	preserveTrailingNewlines: boolean;
}

/** A programming lab's test cases, in the order they are shown */
export function labTests(resource: ContentResource): TestCase[] {
	return [...(resource.payload.testCases ?? [])].sort((a, b) => (a.sortWeight ?? 0) - (b.sortWeight ?? 0));
}

/** Whether a lab is worked through on VMs rather than written as code */
export const isItLab = (resource: ContentResource): boolean => resource.type == 'itlab';

/** The student's submissions to a programming lab, newest last */
export async function labSubmissions(zybook_id: number, resourceId: number): Promise<{ date_submitted: string; score: number }[]> {
	const { submissions } = await api<{ submissions: { date_submitted: string; score: number }[] }>(
		'GET',
		`zybook/${zybook_id}/zystudio/${resourceId}/submissions`
	);
	return submissions.sort((a, b) => a.date_submitted.localeCompare(b.date_submitted));
}

export interface LabFile {
	url: string;
	altText?: string;
}

/** The start of a page of lab instructions */
export interface LabPage {
	pageBreak: true;
	instructions: string;
	taskDescription?: string;
	files: LabFile[];
}

/** Something to do on a VM */
export interface LabStep {
	step: true;
	number: number;
	instructions: string;
	files: LabFile[];
}

/** Points awarded when a command run on a VM gives the expected output */
export interface LabGoal {
	goal: true;
	points: number;
	message: string;
	vmImageTests: { command: string; expected: string; run: boolean }[];
}

export type LabItem = LabPage | LabStep | LabGoal;

export interface VmImage {
	name: string;
	title: string;
	instanceType: string;
}

/** A goal with the positions zyBooks grades it by */
export interface Goal extends LabGoal {
	/** Position of the goal among the lab's items, which is how grading identifies it */
	index: number;
	/** Position of the VM the goal is graded on */
	instance: number;
}

export const isPage = (item: LabItem): item is LabPage => 'pageBreak' in item;
export const isStep = (item: LabItem): item is LabStep => 'step' in item;
export const isGoal = (item: LabItem): item is LabGoal => 'goal' in item;

/** Every graded goal of a lab, in order */
export function labGoals(resource: ContentResource): Goal[] {
	const goals: Goal[] = [];
	for (const [index, item] of (resource.payload.items ?? []).entries()) {
		if (!isGoal(item)) continue;
		goals.push({ ...item, index, instance: Math.max(item.vmImageTests.findIndex(test => test.run), 0) });
	}
	return goals;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Wait for a lab operation, which runs in the background and reports through a status URL */
async function settled<T>(location: string, timeout: number = 600_000): Promise<T> {
	const deadline = Date.now() + timeout;

	for (;;) {
		const status = await itlabs<{ state: string } & T>('GET', location);
		if (status.state == 'SUCCESS') return status;
		if (status.state != 'PENDING') throw new Error('The lab VMs reported ' + status.state.toLowerCase());
		if (Date.now() > deadline) throw new Error('The lab VMs were not ready in time');
		await sleep(5000);
	}
}

/** Start a lab's VMs, which takes a few minutes, and return a URL for each one's screen */
export async function startLab(zybook_code: string, resourceId: number): Promise<string[]> {
	const { location } = await itlabs<{ location: string }>('POST', `zybook/${zybook_code}/content_resource/${resourceId}`, {
		remote_grading: true,
	});
	const { streaming_urls } = await settled<{ streaming_urls?: string[] }>(location);
	if (!streaming_urls?.length) throw new Error('The lab started without any VMs');
	return streaming_urls;
}

/** Shut down a lab's VMs, which are billed for as long as they run */
export async function deleteLab(zybook_code: string, resourceId: number): Promise<void> {
	const { location } = await itlabs<{ location: string }>('DELETE', `zybook/${zybook_code}/content_resource/${resourceId}`);
	await settled(location);
}

/** Which of a lab's points have been earned, one entry per point */
export async function labCompletion(zybook_code: string, resourceId: number): Promise<number[]> {
	const { completed_parts } = await itlabs<{ completed_parts: number[] }>(
		'GET',
		`zybook/${zybook_code}/content_resource/${resourceId}/completion`
	);
	return completed_parts;
}

/** Whether a VM is ready to be graded, which it is once it has finished starting */
export async function gradingReady(zybook_id: number, resourceId: number, instance: number): Promise<boolean> {
	const { is_ready } = await itlabs<{ is_ready: boolean }>('POST', 'grades/is_ready', {
		content_resource_id: resourceId,
		instance_index: instance,
		zybook_id,
	});
	return is_ready;
}

/**
 * Run a goal's test on its VM and record the points if it passes.
 * @returns Whether the goal is now complete
 */
export async function gradeGoal(zybook_id: number, resourceId: number, goal: Goal): Promise<boolean> {
	const { parts } = await itlabs<{ parts: number[] }>('POST', `grades/run_grading/${goal.index}`, {
		content_resource_id: resourceId,
		instance_index: goal.instance,
		zybook_id,
	});
	return parts.includes(1);
}

export interface Question {
	text: any[];
	answers?: string[];
	obey_case?: boolean;
	preferred?: string;
	obey_quote?: boolean;
	obey_space?: boolean;
	text_after: any;
	explanation?: any[];
	obey_linear?: boolean;
	render_html?: boolean;
	text_before: any;
	choices: {
		label: { text: string }[];
		correct: boolean;
	}[];
}

export async function discover() {
	if (!data.user_id) {
		const user_id = await prompt('Enter your user ID: ');
		data.user_id = z.coerce.number().int().parse(user_id.trim());
	}

	if (!data.token) {
		const token = await prompt('Enter your session token: ');
		data.token = token.trim();
	}

	store.update({ user_id: data.user_id, token: data.token });

	let zybooks;

	try {
		const res = await api('GET', `user/${data.user_id}/items?items=["zybooks"]`);
		zybooks = res.items.zybooks;
	} catch (e) {
		if (
			!(e instanceof Error)
			|| (e.message != 'Auth token is expired.' && e.message != 'Your session has expired, please refresh the page.')
		)
			throw e;
		store.update({ token: null });
		return await discover();
	}

	for (const book of zybooks) {
		if (book.autosubscribe || data.books.includes(book.zybook_code)) continue;

		data.books.push(book.zybook_code);
		onAdd('zybook', book.title);
	}

	store.update({ books: data.books });
}

// Regex to match: <meta name="zybooks-web/config/environment" content="...">
const buildConfigRegex = /<meta\b[^>]*\bname="zybooks-web\/config\/environment"[^>]*\bcontent=(["'])(?<content>(?:\\.|(?!\1).)*)\1/i;

export async function getBuildKey() {
	const res = await fetch('https://learn.zybooks.com', {
		headers: {
			'User-Agent': `Mozilla/5.0 (compatible; eedu/${$pkg.version})`,
			Authorization: `Bearer ${data.token}`,
		},
	});
	const content = await res.text();

	const match = content.match(buildConfigRegex);
	if (!match) throw new Error('Could not find build key');

	const config = JSON.parse(decodeURIComponent(match.groups!.content));
	return config.APP.BUILDKEY;
}

export function resourceName(chapter: Chapter, section: ChapterSection, resource: ContentResource, names: boolean): string {
	let text = `${chapter.number}.${section.number}.${resource._number}`;
	if (names) text += ` [${chapter.title} > ${section.title}${resource.caption ? ' > ' + resource.caption : ''}]`;
	return text;
}

/** An IT lab, which is worked through on VMs instead of being answered */
export interface Lab {
	zybook_code: string;
	zybook_id: number;
	/** The subject the lab belongs to, which zyStudio needs to open its workspace */
	subject_id: number;
	name: string;
	resource: ContentResource;
}

export interface AutoOptions {
	chapter?: number;
	section?: number;
	delay?: number;
	dryRun: boolean;
	force: boolean;
	showNames: boolean;
	onSkip?(name: string, resource: ContentResource, reason: string, show?: boolean): void;
	onComplete?(name: string, resource: ContentResource, part?: number): void;
	/** Work through a lab. Labs are skipped when this is unset. */
	onLab?(lab: Lab): Promise<void>;
}

let buildKey: string;

function createBody(zybook_code: string, resourceId: number, part: number, extra?: any): object {
	const timestamp = new Date().toISOString();
	const md5 = createHash('md5');
	const raw = `content_resource/${resourceId}/activity${timestamp}${data.token}${resourceId}${part}true${buildKey}`;
	md5.update(raw, 'utf8');
	const __cs__ = md5.digest('hex');

	return {
		part,
		complete: true,
		metadata: {
			isTrusted: true,
			computerTime: timestamp,
			...(extra?.metadata || {}),
		},
		zybook_code,
		auth_token: data.token,
		timestamp,
		__cs__,
		...extra,
	};
}

export async function autoComplete(zybook_code: string, opts: AutoOptions) {
	if (!data.token || !data.user_id) throw new Error('Missing session information');

	function delay() {
		if (!opts.delay) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, opts.delay);
		return promise;
	}

	buildKey = await getBuildKey();

	const {
		zybooks: [{ chapters, zybook_id }],
	} = await api<{ zybooks: { chapters: Chapter[]; zybook_id: number }[] }>('GET', `zybooks?zybooks=["${zybook_code}"]`);

	for (const chapter of chapters) {
		if (typeof opts.chapter == 'number' && chapter.number != opts.chapter) continue;

		for (const section of chapter.sections) {
			if (typeof opts.section == 'number' && section.number != opts.section) continue;

			const {
				section: { content_resources },
			} = await api<{ section: Section }>('GET', `zybook/${zybook_code}/chapter/${chapter.number}/section/${section.number}`).catch(
				() =>
					api<{ section: Section }>(
						'GET',
						`zybook/${zybook_code}/chapter/${chapter.number}/section/${section.canonical_section_number}`
					)
			);

			for (const [i, resource] of content_resources.entries()) {
				resource._number = i + 1;
				const name = resourceName(chapter, section, resource, opts.showNames);
				if (data.completed_resources.includes(resource.id) && !opts.force) {
					opts.onSkip?.(name, resource, 'already completed');
					continue;
				}
				if (resource.activity_type == 'lab') {
					if (!opts.onLab) opts.onSkip?.(name, resource, 'labs are only done with --labs', true);
					else if (opts.dryRun) opts.onSkip?.(name, resource, 'dry run', true);
					else await opts.onLab({ zybook_code, zybook_id, subject_id: section.subject_id, name, resource });
					continue;
				}
				switch (resource.type) {
					case 'container':
					case 'html':
						break;
					case 'multiple_choice':
						for (const [part, question] of resource.payload.questions.entries()) {
							const answer = question.choices.find(c => c.correct)!.label[0].text;
							const body = createBody(zybook_code, resource.id, part, { answer });
							opts.onComplete?.(name, resource, part);
							if (!opts.dryRun) await api('POST', `content_resource/${resource.id}/activity`, body);
							await delay();
						}
						break;
					case 'short_answer':
						for (const [part, question] of resource.payload.questions.entries()) {
							const answer = question.preferred;
							const body = createBody(zybook_code, resource.id, part, {
								answer,
								metadata: {
									caseDiffers: false,
									quoteDiffers: false,
									stringDiffHighlight: null,
									type: 'correct',
									whitespaceDiffers: false,
									isTrusted: { isTrusted: true },
								},
							});
							opts.onComplete?.(name, resource, part);
							if (!opts.dryRun) await api('POST', `content_resource/${resource.id}/activity`, body);
							await delay();
						}
						break;
					default:
					case 'custom':
						for (let part = 0; part < resource.parts; part++) {
							const body = createBody(zybook_code, resource.id, part);
							opts.onComplete?.(name, resource, part);
							if (!opts.dryRun) await api('POST', `content_resource/${resource.id}/activity`, body);
							await delay();
						}
						break;
				}
				if (!data.completed_resources.includes(resource.id)) data.completed_resources.push(resource.id);
				store.update({ completed_resources: data.completed_resources });
			}
		}
	}

	store.update({ completed_resources: data.completed_resources });
}
