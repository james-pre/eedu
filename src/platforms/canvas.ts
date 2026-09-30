import * as z from 'zod';
import $pkg from '../../package.json' with { type: 'json' };
import { Manager } from '@james-pre/config';
import * as io from 'ioium/node';
import { join } from 'node:path';
import { dataDir, school } from '../data.js';
import { onAdd, prompt, type DiscoverOptions } from '../discovery.js';
import { discover as discoverZybooks } from './zybooks.js';
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

async function request(method: string, endpoint: string, body?: any, headers: Record<string, string> = {}) {
	if (!data.origin || !data.token) throw new Error('Canvas is not set up, run `eedu discover canvas`');

	const url = new URL(endpoint, data.origin + '/api/v1/');
	const response = await fetch(url, {
		method,
		body: method == 'GET' || method == 'HEAD' ? null : JSON.stringify(body),
		headers: {
			Authorization: `Bearer ${data.token}`,
			'User-Agent': `Mozilla/5.0 (compatible; eedu/${$pkg.version})`,
			'Content-Type': 'application/json',
			...headers,
		},
	});

	if (response.status == 401 && response.headers.has('WWW-Authenticate')) throw new TokenError();

	const json: any = await response.json().catch(() => ({ errors: [{ message: response.statusText }] }));

	if (!response.ok) {
		const [{ message } = {}] = json.errors || [];
		throw new Error(message ?? `${method} ${endpoint} failed: ` + response.statusText);
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

		if (!existing) {
			school.data.courses.push({
				id: course.course_code,
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
