import * as z from 'zod';
import $pkg from '../../package.json' with { type: 'json' };
import { courses, dataFrom, terms } from '../data.js';
import { onAdd, prompt, type DiscoverOptions } from '../discovery.js';
import { discover as discoverZybooks } from './zybooks.js';
import { normalizeURL } from '../utils.js';

export const CanvasData = z
	.object({
		token: z.string(),
		origin: z.url(),
	})
	.partial();

export interface CanvasData extends z.infer<typeof CanvasData> {}

export let data = dataFrom('canvas.json', CanvasData, {});

export async function api(method: string, endpoint: string, body?: any, headers: Record<string, string> = {}): Promise<any> {
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

	const json: any = await response.json().catch(() => ({ errors: [{ message: response.statusText }] }));

	if (!response.ok) {
		const [{ message } = {}] = json.errors || [];
		throw new Error(message ?? `${method} ${endpoint} failed: ` + response.statusText);
	}

	return json;
}

export async function discover(options: DiscoverOptions) {
	if (!data.origin) {
		const domain = await prompt('Enter the Canvas instance domain: ');
		data.origin = normalizeURL(domain).origin;
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

	data.write();

	for (const course of await api('GET', 'courses?include[]=term')) {
		const existing_term = terms.find(t => t.canvas_id == course.term.id);

		const term_id = course.term.name.replace(/\s+/g, '_').toLowerCase();

		if (course.term && !existing_term) {
			terms.push({
				id: term_id,
				name: course.term.name,
				start: new Date(course.term.start_at),
				end: new Date(course.term.end_at),
				canvas_id: course.term.id,
			});
			onAdd('term', course.term.name);
		}

		const existing = courses.find(c => c.canvas_id == course.id);

		if (!existing) {
			courses.push({
				id: course.course_code,
				name: course.name,
				term: term_id,
				canvas_id: course.id,
			});
			onAdd('course', course.name);
		}

		if (!options.recursive) continue;

		const modules = await api('GET', `courses/${course.id}/modules?include[]=items`);

		for (const module of modules) {
			module.items ||= await api('GET', module.items);
			for (const item of module.items) {
				if (item.type != 'ExternalTool') continue;

				const { hostname } = new URL(item.external_url);
				if (hostname.endsWith('.zybooks.com')) {
					console.log('\tZyBook:', module.name, '->', item.title);
					await discoverZybooks();
				}
			}
		}
	}

	terms.write();
	courses.write();
}
