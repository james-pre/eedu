import * as io from 'ioium/node';
import { courseId, school, uniqueCourseId } from '../../data.js';
import { onAdd, prompt, type DiscoverOptions } from '../../discovery.js';
import { renameCourse } from '../../grades.js';
import { normalizeURL } from '../../utils.js';
import { discover as discoverZybooks } from '../zybooks/discover.js';
import { api, apiAll, data, store, TokenError } from './api.js';
import type * as types from './types.js';

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
