import $pkg from '../../../package.json' with { type: 'json' };
import type { Course } from '../../data.js';
import { api, data } from './api.js';
import { putRecords, type KinesisConfiguration } from './kinesis.js';

/** Whether an external tool URL is New Quizzes */
export function isQuizTool(url?: string): boolean {
	return !!url && /\.quiz-lti-[\w-]+\.instructure\.com$/.test(URL.parse(url)?.hostname ?? '');
}

const userAgent = `Mozilla/5.0 (compatible; eedu/${$pkg.version})`;

export class QuizError extends Error {}

/** What New Quizzes' native launch gives the page it renders in */
interface NativeLaunch {
	access_token: string;
	entry_path: { workflow: string; resourceId: number | string };
	rldb_launch?: boolean;
	assignment_type?: string;
}

/** A student's attempts at one quiz, as quiz-lti tracks them */
interface ParticipantSession {
	quiz_api_quiz_session_id: number;
	host: string;
	token: string;
	session_lock: unknown;
	participant_session: { id: string; status: string; lock_at: string | null; submitted_at: string | null };
}

export interface QuizSession {
	id: string;
	status: string;
	start_at: string | null;
	end_at: string | null;
	attempt: number;
	accepted_student_access_code: boolean;
	account_uuid: string;
	root_account_uuid: string;
	event_creation_token: string;
	kinesis_credentials: KinesisConfiguration;
	one_at_a_time_type: string;
	allow_backtracking: boolean;
	quiz: {
		id: string;
		title: string;
		instructions: string | null;
		has_time_limit: boolean;
		session_time_limit_in_seconds: number;
		require_student_access_code: boolean;
		filter_ip_address: boolean;
		quiz_type: string;
	};
	ip_is_allowed: boolean;
}

export interface SessionItem {
	position: number;
	points_possible: number;
	stimulus: { title?: string; body?: string; item_body?: string } | null;
	item: {
		id: string;
		title: string;
		/** HTML */
		item_body: string;
		user_response_type: string;
		interaction_type: { slug: string; name: string };
		interaction_data: Record<string, any>;
		properties: Record<string, any>;
	};
}

/** An attempt that has been started, which is what answers are submitted to */
export interface OpenQuiz {
	/** The participant session, which is what Canvas' quiz page calls the attempt */
	attempt: string;
	session: QuizSession;
	items: SessionItem[];
	/** Practice quizzes and surveys aren't graded */
	type?: string;
	/** Saved answers by position */
	responses: Map<number, ResponseValue>;
	lti: { base: string; token: string; domain: string };
	api: { host: string; token: string };
	/** Identifies this client in the events quiz-api records, like a browser tab */
	browserSessionId: string;
	ipAddress: string | null;
}

/** Pull a value out of the `ENV` object Canvas puts in its pages */
function envValue(html: string, key: string): unknown {
	const marker = `"${key}":`;
	const start = html.indexOf(marker);
	if (start == -1) return;
	let end = start + marker.length;
	if (html[end] != '{') return JSON.parse(html.slice(end).match(/^("(?:[^"\\]|\\.)*"|[\w.-]+)/)?.[0] ?? 'null');

	let depth = 0;
	for (let inString = false; end < html.length; end++) {
		const character = html[end];
		if (inString) {
			if (character == '\\') end++;
			else if (character == '"') inString = false;
		} else if (character == '"') inString = true;
		else if (character == '{') depth++;
		else if (character == '}' && !--depth) break;
	}
	return JSON.parse(html.slice(start + marker.length, end + 1));
}

/**
 * Open the assignment's page in a session made from the access token, the way a browser would.
 * New Quizzes only gives its signed launch data to that page.
 */
async function launchPage(course: Course, assignment: string): Promise<string> {
	const { url } = await api<{ url: string }>(
		'GET',
		`courses/${course.canvas_id}/external_tools/sessionless_launch?launch_type=assessment&assignment_id=${assignment}`
	);

	const cookies = new Map<string, string>();
	let next = url;
	for (let redirects = 0; redirects < 10; redirects++) {
		const response = await fetch(next, {
			redirect: 'manual',
			headers: { 'User-Agent': userAgent, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
		});
		for (const cookie of response.headers.getSetCookie()) {
			const [pair] = cookie.split(';');
			const equals = pair.indexOf('=');
			cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
		}
		const location = response.headers.get('Location');
		if (!location) {
			if (!response.ok) throw new QuizError('Could not open the quiz: ' + response.statusText);
			return await response.text();
		}
		next = new URL(location, next).href;
	}
	throw new QuizError('Could not open the quiz: too many redirects');
}

async function lti<T>(quiz: Pick<OpenQuiz, 'lti'>, method: string, endpoint: string, body?: object): Promise<T> {
	const response = await fetch(quiz.lti.base + endpoint, {
		method,
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${quiz.lti.token}`,
			'User-Agent': userAgent,
			'X-Domain': quiz.lti.domain,
			...(body && { 'Content-Type': 'application/json' }),
		},
		body: body && JSON.stringify(body),
	});
	const json: any = await response.json().catch(() => ({}));
	if (!response.ok) throw new QuizError(json.error ?? `${method} ${endpoint} failed: ` + response.statusText);
	return json;
}

async function quizApi<T>(quiz: Pick<OpenQuiz, 'api'>, method: string, endpoint: string, body?: object): Promise<T> {
	const response = await fetch(quiz.api.host + '/api' + endpoint, {
		method,
		headers: {
			Accept: 'application/json',
			Authorization: quiz.api.token,
			AuthType: 'Signature',
			'User-Agent': userAgent,
			...(body && { 'Content-Type': 'application/json' }),
		},
		body: body && JSON.stringify(body),
	});
	if (response.status == 204) return null as T;
	const json: any = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new QuizError(json.errors?.[0]?.message ?? json.error ?? `${method} ${endpoint} failed: ` + response.statusText);
	return json;
}

/** Statuses of an attempt that has been turned in */
const finished = ['submitted', 'needs_grading', 'graded', 'complete', 'completed'];

/** Wrong access codes tried before giving up, since quiz-api throttles them */
const accessCodeAttempts = 3;

export interface OpenOptions {
	/** Ask the student for the quiz's access code, resolving to nothing to give up */
	accessCode?(quiz: string, rejected: boolean): Promise<string | undefined>;
	/** Called when a warning is encountered */
	onWarning?(message: string): void;
}

const ldbMessage = 'This quiz requires Respondus LockDown Browser. Try running `eedu auto qemu` with the quiz open in a virtual machine.';

/**
 * Start or resume the student's attempt at a New Quizzes assignment.
 * Refuses quizzes that need LockDown Browser or a particular network, and ones that need an access code the student doesn't give.
 */
export async function open(course: Course, assignment: string, options: OpenOptions = {}): Promise<OpenQuiz> {
	const html = await launchPage(course, assignment);
	const launch = envValue(html, 'NEW_QUIZZES') as { params: Record<string, string>; signature: string } | undefined;
	const account = envValue(html, 'ACCOUNT_ID');
	if (!launch?.params?.backend_url) throw new QuizError('This assignment is not a New Quizzes quiz');

	if (String(launch.params.custom_canvas_assignment_ldb_enabled) == 'true') throw new QuizError(ldbMessage);

	const { token } = await api<{ token: string }>(
		'POST',
		`jwts?canvas_audience=false&workflows[]=new_quizzes_native_launch&context_id=${account}&context_type=account`
	);

	const domain = launch.params.tool_consumer_instance_guid?.split(':')[0] ?? new URL(data.origin!).hostname;
	const native = await lti<NativeLaunch>({ lti: { base: launch.params.backend_url + '/api', token, domain } }, 'POST', '/native/launch', {
		params: launch.params,
		signature: launch.signature,
	});

	if (native.rldb_launch) throw new QuizError(ldbMessage);

	const quiz = { lti: { base: launch.params.backend_url + '/api', token: native.access_token, domain } };
	const { workflow, resourceId } = native.entry_path;
	if (workflow != 'taking') throw new QuizError(`The quiz opened to ${workflow} instead of taking it, it may already be submitted`);

	const participant = await lti<ParticipantSession>(quiz, 'GET', `/participant_sessions/${resourceId}`);
	if (finished.includes(participant.participant_session.status)) throw new QuizError('This quiz has already been submitted');

	const shown = { api: { host: participant.host, token: participant.token } };
	const preview = await quizApi<QuizSession>(shown, 'GET', `/quiz_sessions/${participant.quiz_api_quiz_session_id}`);

	if (preview.quiz.filter_ip_address && !preview.ip_is_allowed)
		options.onWarning?.("This quiz has a network restriction. It might only be available on the school's network or VPN");

	for (let tries = 0; preview.quiz.require_student_access_code && !preview.accepted_student_access_code; tries++) {
		if (tries == accessCodeAttempts) throw new QuizError('The access code was rejected ' + tries + ' times');
		const code = (await options.accessCode?.(preview.quiz.title, tries > 0))?.trim();
		if (!code) throw new QuizError('This quiz requires an access code from the instructor');
		const checked = await quizApi<QuizSession>(shown, 'POST', `/quiz_sessions/${preview.id}/submit_student_access_code`, {
			accessCode: code,
		});
		preview.accepted_student_access_code = checked.accepted_student_access_code;
	}

	const taking = await lti<ParticipantSession>(quiz, 'POST', `/participant_sessions/${resourceId}/take`, {
		session_lock: participant.session_lock,
	});
	const taken = { api: { host: taking.host, token: taking.token } };
	const id = taking.quiz_api_quiz_session_id;

	const session = await quizApi<QuizSession>(taken, 'POST', `/quiz_sessions/${id}/take`, {});
	const items = await quizApi<SessionItem[]>(taken, 'GET', `/quiz_sessions/${id}/session_items`);
	const saved = await quizApi<ResumeData[]>(taken, 'GET', `/quiz_sessions/${id}/session_item_responses/resume_data`);
	const { ip } = await quizApi<{ ip: string | null }>(taken, 'GET', `/quiz_sessions/${id}/get_ip_address`).catch(() => ({ ip: null }));

	return {
		attempt: String(resourceId),
		session,
		items,
		type: native.assignment_type,
		responses: new Map(
			saved
				.filter(response => response.user_response?.value != null)
				.map(response => [response.position, response.user_response!.value])
		),
		lti: quiz.lti,
		...taken,
		browserSessionId: crypto.randomUUID(),
		ipAddress: ip,
	};
}

/** A saved answer, as quiz-api returns them when an attempt is resumed */
interface ResumeData {
	position: number;
	item_id: string;
	user_response?: { value: ResponseValue };
}

/** Whether each answer is final once saved, because the quiz shows one question at a time without going back */
export function forwardOnly(quiz: OpenQuiz): boolean {
	return quiz.session.one_at_a_time_type == 'question' && !quiz.session.allow_backtracking;
}

/** Kinesis credentials, refreshed when they're about to expire */
async function kinesis(quiz: OpenQuiz): Promise<KinesisConfiguration> {
	const configuration = quiz.session.kinesis_credentials;
	if (new Date(configuration.credentials.expiration).getTime() - Date.now() > 60_000) return configuration;
	quiz.session.kinesis_credentials = await quizApi<KinesisConfiguration>(
		quiz,
		'POST',
		`/quiz_sessions/${quiz.session.id}/kinesis_credentials`,
		{}
	);
	return quiz.session.kinesis_credentials;
}

/**
 * Save the answer to one question, the way typing it into the quiz does.
 * When the quiz only goes forward, this moves on and returns the next question, or null after the last one.
 */
export async function save(quiz: OpenQuiz, response: Response): Promise<SessionItem | null | undefined> {
	const item = quiz.items.find(item => item.position == response.position);
	if (!item) throw new QuizError(`The quiz has no question ${response.position}`);

	if (forwardOnly(quiz)) {
		const next = await quizApi<SessionItem | null>(
			quiz,
			'POST',
			`/quiz_sessions/${quiz.session.id}/session_item_responses/single_response_submit`,
			{
				sessionItemResponse: { itemId: item.item.id, position: item.position, userResponse: { value: response.value } },
			}
		);
		quiz.responses.set(item.position, response.value);
		if (next && !quiz.items.some(existing => existing.position == next.position)) quiz.items.push(next);
		return next;
	}

	const { session } = quiz;
	const record = {
		account_uuid: session.account_uuid,
		event_creation_token: session.event_creation_token,
		event_type: 'RESPONSE',
		quiz_session_id: session.id,
		root_account_uuid: session.root_account_uuid,
		position: item.position,
		item_id: item.item.id,
		user_response: { value: response.value },
		event_data: {
			invalid: false,
			user_agent: userAgent,
			browser_session_id: quiz.browserSessionId,
			client_timestamp: new Date(),
			ip_address: quiz.ipAddress,
			multiple_session_attempt: false,
		},
		created_at: `${new Date().toISOString()}|${performance.now()}`,
	};

	const configuration = await kinesis(quiz);
	await putRecords(configuration, configuration.stream_identifiers.responses, [
		{ data: JSON.stringify(record), partitionKey: `${session.id}|${session.account_uuid}` },
	]);
	quiz.responses.set(item.position, response.value);
}

/** What a student's answer to one item looks like, by interaction type */
export type ResponseValue = string | number | boolean | null | ResponseValue[] | { [key: string]: ResponseValue };

export interface Response {
	position: number;
	value: ResponseValue;
}

/** Turn in the attempt with its saved answers, which is final */
export async function submit(quiz: OpenQuiz): Promise<void> {
	const items = new Map(quiz.items.map(item => [item.position, item]));
	const session_item_responses = [...quiz.responses].map(([position, value]) => ({
		position,
		itemId: items.get(position)!.item.id,
		userResponse: { value },
		clientTimestamp: Date.now(),
	}));

	await quizApi(quiz, 'POST', `/quiz_sessions/${quiz.session.id}/submit`, {
		session_item_responses,
		submission_source: 'browser_session_id:' + crypto.randomUUID(),
	});
	await lti(quiz, 'PATCH', `/participant_sessions/${quiz.attempt}`, { participant_session: { status: 'needs_grading' } });
}
