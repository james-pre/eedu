import $pkg from '../../../package.json' with { type: 'json' };
import type { Course } from '../../data.js';
import { api, data } from '../canvas.js';

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
	end_at: string | null;
	attempt: number;
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
	lti: { base: string; token: string; domain: string };
	api: { host: string; token: string };
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
	if (!response.ok) throw new QuizError(json.errors?.[0]?.message ?? json.error ?? `${method} ${endpoint} failed: ` + response.statusText);
	return json;
}

/** Statuses of an attempt that has been turned in */
const finished = ['submitted', 'needs_grading', 'graded', 'complete', 'completed'];

/**
 * Start or resume the student's attempt at a New Quizzes assignment.
 * Refuses quizzes that need LockDown Browser, an access code, or a particular network, and won't start a timed attempt.
 */
export async function open(course: Course, assignment: string): Promise<OpenQuiz> {
	const html = await launchPage(course, assignment);
	const launch = envValue(html, 'NEW_QUIZZES') as { params: Record<string, string>; signature: string } | undefined;
	const account = envValue(html, 'ACCOUNT_ID');
	if (!launch?.params?.backend_url) throw new QuizError('This assignment is not a New Quizzes quiz');

	if (String(launch.params.custom_canvas_assignment_ldb_enabled) == 'true')
		throw new QuizError('This quiz requires Respondus LockDown Browser, so eedu will not take it');

	const { token } = await api<{ token: string }>(
		'POST',
		`jwts?canvas_audience=false&workflows[]=new_quizzes_native_launch&context_id=${account}&context_type=account`
	);

	const domain = launch.params.tool_consumer_instance_guid?.split(':')[0] ?? new URL(data.origin!).hostname;
	const native = await lti<NativeLaunch>({ lti: { base: launch.params.backend_url + '/api', token, domain } }, 'POST', '/native/launch', {
		params: launch.params,
		signature: launch.signature,
	});

	if (native.rldb_launch) throw new QuizError('This quiz requires Respondus LockDown Browser, so eedu will not take it');

	const quiz = { lti: { base: launch.params.backend_url + '/api', token: native.access_token, domain } };
	const { workflow, resourceId } = native.entry_path;
	if (workflow != 'taking') throw new QuizError(`The quiz opened to ${workflow} instead of taking it, it may already be submitted`);

	const participant = await lti<ParticipantSession>(quiz, 'GET', `/participant_sessions/${resourceId}`);
	if (finished.includes(participant.participant_session.status)) throw new QuizError('This quiz has already been submitted');

	const preview = await quizApi<QuizSession>(
		{ api: { host: participant.host, token: participant.token } },
		'GET',
		`/quiz_sessions/${participant.quiz_api_quiz_session_id}`
	);

	if (preview.quiz.require_student_access_code) throw new QuizError('This quiz requires an access code from the instructor');
	if (preview.quiz.filter_ip_address && !preview.ip_is_allowed) throw new QuizError("This quiz can't be taken from this network");
	if (preview.quiz.has_time_limit && preview.status != 'in_progress')
		throw new QuizError('This quiz has a time limit, so eedu will not start it; start it yourself first');

	const taking = await lti<ParticipantSession>(quiz, 'POST', `/participant_sessions/${resourceId}/take`, {
		session_lock: participant.session_lock,
	});
	const taken = { api: { host: taking.host, token: taking.token } };
	const id = taking.quiz_api_quiz_session_id;

	const session = await quizApi<QuizSession>(taken, 'GET', `/quiz_sessions/${id}`);
	if (session.one_at_a_time_type != 'none' && !session.allow_backtracking)
		throw new QuizError("This quiz shows one question at a time without going back, which eedu doesn't support");

	const items = await quizApi<SessionItem[]>(taken, 'GET', `/quiz_sessions/${id}/session_items`);

	return { attempt: String(resourceId), session, items, type: native.assignment_type, lti: quiz.lti, ...taken };
}

/** What a student's answer to one item looks like, by interaction type */
export type ResponseValue = string | number | boolean | null | ResponseValue[] | { [key: string]: ResponseValue };

export interface Response {
	position: number;
	value: ResponseValue;
}

/** Turn in the attempt with these answers, which is final */
export async function submit(quiz: OpenQuiz, responses: Response[]): Promise<void> {
	const items = new Map(quiz.items.map(item => [item.position, item]));
	const session_item_responses = responses.map(({ position, value }) => ({
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
