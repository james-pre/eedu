import $pkg from '../../../package.json' with { type: 'json' };
import { api, data } from './api.js';
import type { Lab } from './types.js';

/** The editor zyBooks runs programming labs in, which holds each student's files and grades them */
const base = 'https://cc-api.zybooks.com';

/** An opened lab workspace, which is where the student's code for one lab lives */
export interface Workspace {
	/** The lab as zyStudio knows it, which is not the zyBooks resource ID */
	resource: number;
	id: number;
	token: string;
	aciToken: string;
}

export interface WorkspaceFile {
	name: string;
	content: string;
	/** Whether this is the file the lab opens to, which is the one to edit */
	isDefault: boolean;
}

async function request<T>(workspace: Pick<Workspace, 'aciToken'>, method: string, endpoint: string, body?: object): Promise<T> {
	const response = await fetch(base + endpoint, {
		method,
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': `Mozilla/5.0 (compatible; eedu/${$pkg.version})`,
			'x-platform-token': workspace.aciToken,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const json: any = await response.json().catch(() => ({ message: `${method} ${endpoint} failed: ` + response.statusText }));
	if (!response.ok || json.success === false) throw new Error(json.message ?? `${method} ${endpoint} failed: ` + response.statusText);
	return json.data;
}

/** Open a lab's workspace, creating the tokens that let eedu read and write the student's files */
export async function open(lab: Lab): Promise<Workspace> {
	const query = new URLSearchParams({
		access: 'rw',
		actor: `user_id:${data.user_id}`,
		content_resource_id: String(lab.resource.id),
		frame_id: crypto.randomUUID(),
		guid: lab.resource.guid ?? '',
		kinds: 'student-work',
		release_id: String(lab.resource.release_id),
		subject_id: String(lab.subject_id),
		zybook_id: String(lab.zybook_id),
	});

	const { token, aci_token } = await api<{ token: string; aci_token: string }>('GET', `zystudio/resource_token?${query}`);

	const exchanged = await request<Record<string, { id: number; workspaceId: number }>>(
		{ aciToken: aci_token },
		'POST',
		'/v1/zystudio/resource-tokens/exchange',
		{ resourceToken: token, checkIfConfigTemplate: false }
	);

	const work = exchanged['student-work'];
	if (!work) throw new Error('zyStudio did not open a workspace for this lab');

	return { resource: work.id, id: work.workspaceId, token, aciToken: aci_token };
}

/** Every file in the workspace, including the lab's starting code */
export async function files(workspace: Workspace): Promise<WorkspaceFile[]> {
	const contents = await request<{ file: { filename: string }; isDefaultFile: boolean; strContentBase64?: string }[]>(
		workspace,
		'POST',
		`/v1/zystudio/resources/${workspace.resource}/workspace-content`,
		{
			resourceToken: workspace.token,
			omitFileContent: false,
			includeDotFiles: false,
		}
	);

	return contents.map(({ file, isDefaultFile, strContentBase64 }) => ({
		name: file.filename,
		content: strContentBase64 ? Buffer.from(strContentBase64, 'base64').toString('utf8') : '',
		isDefault: isDefaultFile,
	}));
}

/** The characters zyStudio numbers a document's revisions with */
const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function revisionId(revision: number): string {
	if (!revision) return 'A0';
	let id = '';
	for (let left = revision; left > 0; left = Math.floor(left / digits.length)) id = digits[left % digits.length] + id;
	return String.fromCharCode(64 + id.length) + id;
}

function revisionNumber(id: string): number {
	return [...id.slice(1)].reduce((value, character) => value * digits.length + digits.indexOf(character), 0);
}

/** Sign in to the editor's document store, where the code itself is kept */
async function editor(workspace: Workspace): Promise<{ url: string; token: string; user: string }> {
	await request(workspace, 'POST', '/v1/me/uws').catch(() => {});

	const details = await request<{ firebaseDomain: string; firebaseWorkspaceKey: string }>(
		workspace,
		'GET',
		`/v1/workspaces/${workspace.id}`
	);
	const { firebaseCustomToken } = await request<{ firebaseCustomToken: string }>(
		workspace,
		'POST',
		'/v1/auth/exchange-firebase-token',
		{}
	);

	const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${editorKey}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ token: firebaseCustomToken, returnSecureToken: true }),
	});

	const { idToken } = (await response.json()) as { idToken?: string };
	if (!idToken) throw new Error('Could not sign in to the zyStudio editor');

	const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
	const base = details.firebaseDomain.replace(/\/$/, '');
	return { url: `${base}/${details.firebaseWorkspaceKey}/codepads`, token: idToken, user: String(claims.user_id ?? claims.sub) };
}

const editorKey = 'AIzaSyCtumYrtfU9uUR22l1_M6Z29TTtZRYQKi0';

/** The editor's ID for each file, which is how its text is addressed */
async function fileIds(workspace: Workspace): Promise<Map<string, string>> {
	const contents = await request<{ file: { filename: string; fileId: string } }[]>(
		workspace,
		'POST',
		`/v1/zystudio/resources/${workspace.resource}/workspace-content`,
		{ resourceToken: workspace.token, omitFileContent: true, includeDotFiles: false }
	);
	return new Map(contents.map(({ file }) => [file.filename, file.fileId]));
}

/**
 * Replace a file's text in the workspace, which is what the student would type into the editor.
 * The editor keeps each file as a list of edits, so this appends one that replaces everything.
 */
export async function writeFile(workspace: Workspace, filename: string, content: string): Promise<void> {
	const id = (await fileIds(workspace)).get(filename);
	if (!id) throw new Error(`${filename} is not one of the lab's files`);

	const current = (await files(workspace)).find(file => file.name == filename)?.content ?? '';
	if (current == content) return;

	const { url, token, user } = await editor(workspace);
	const history = await fetch(`${url}/${id}/history.json?auth=${token}&shallow=true`);
	const revisions = ((await history.json()) ?? {}) as Record<string, true>;
	const next = revisionId(Math.max(-1, ...Object.keys(revisions).map(revisionNumber)) + 1);

	const edit = await fetch(`${url}/${id}/history/${next}.json?auth=${token}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ a: user, o: [-[...current].length, content], t: { '.sv': 'timestamp' } }),
	});

	if (!edit.ok) throw new Error(`The zyStudio editor rejected the change to ${filename}`);
}

interface ScoreResponse {
	pointsReceived: number;
	pointsPossible: number;
	/** How many decimal places the point totals carry */
	pointsScale: number;
	results: { title?: string; passed: boolean; expectedOutput?: string; actualOutput?: string; codeError?: string }[];
	responseId?: string;
	status?: string;
}

export interface Score {
	points: number;
	possible: number;
	results: { title: string; passed: boolean; expected?: string; actual?: string; error?: string }[];
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function scoreOf(response: ScoreResponse): Score {
	const scale = 10 ** (response.pointsScale ?? 0);
	return {
		points: response.pointsReceived / scale,
		possible: response.pointsPossible / scale,
		results: (response.results ?? []).map((result, i) => ({
			title: result.title || `Test ${i + 1}`,
			passed: result.passed,
			expected: result.expectedOutput,
			actual: result.actualOutput,
			error: result.codeError || undefined,
		})),
	};
}

/**
 * Run the lab's tests on the workspace, which is what pressing Submit does.
 * This counts as a submission on its own, and labs can limit how many a student gets.
 */
export async function score(workspace: Workspace, timeout: number = 300_000): Promise<Score> {
	const started = await request<ScoreResponse>(workspace, 'POST', `/v1/zystudio/resources/${workspace.resource}/score`, {
		resourceToken: workspace.token,
	});

	if (!started.responseId) return scoreOf(started);

	const deadline = Date.now() + timeout;
	for (;;) {
		await sleep(3000);
		const status = await request<ScoreResponse>(
			workspace,
			'POST',
			`/v1/zystudio/resources/${workspace.resource}/score-status/${started.responseId}`,
			{ resourceToken: workspace.token }
		);
		if (status.status?.toLowerCase() == 'complete') return scoreOf(status);
		if (Date.now() > deadline) throw new Error('zyStudio did not finish the tests in time');
	}
}

/** Put a scored run in the gradebook, which is the last step of submitting */
export async function recordSubmission(zybook_code: string, resourceId: number): Promise<void> {
	await api('PUT', `zybook/${zybook_code}/zystudio/${resourceId}/record_submission`);
}

/** The student's submissions to a programming lab, newest last */
export async function labSubmissions(zybook_id: number, resourceId: number): Promise<{ date_submitted: string; score: number }[]> {
	const { submissions } = await api<{ submissions: { date_submitted: string; score: number }[] }>(
		'GET',
		`zybook/${zybook_id}/zystudio/${resourceId}/submissions`
	);
	return submissions.sort((a, b) => a.date_submitted.localeCompare(b.date_submitted));
}
