import { Manager } from '@james-pre/config';
import { join } from 'node:path';
import * as z from 'zod';
import $pkg from '../../../package.json' with { type: 'json' };
import { dataDir } from '../../data.js';

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
