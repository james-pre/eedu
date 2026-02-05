import * as z from 'zod';
import $pkg from '../../package.json' with { type: 'json' };
import { dataFrom } from '../data.js';
import { onAdd, prompt } from '../discovery.js';
import { createHash } from 'node:crypto';

export const ZybooksData = z.object({
	token: z.string().optional(),
	user_id: z.int().optional(),
	books: z.string().array().default([]),
	completed_resources: z.int().array().default([]),
});

export interface ZybooksData extends z.infer<typeof ZybooksData> {}

export let data = dataFrom('zybooks.json', ZybooksData, { books: [], completed_resources: [] });

export async function api(method: string, endpoint: string, body?: any, headers: Record<string, string> = {}): Promise<any> {
	const url = new URL(endpoint, 'https://zyserver.zybooks.com/v1/');
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

export async function discover() {
	if (!data.token) {
		const token = await prompt('Enter your session token: ');
		data.token = token.trim();
	}

	if (!data.user_id) {
		const user_id = await prompt('Enter your user ID: ');
		data.user_id = z.coerce.number().int().parse(user_id.trim());
	}

	data.write();

	const {
		items: { zybooks },
	} = await api('GET', `user/${data.user_id}/items?items=["zybooks"]`);

	for (const book of zybooks) {
		if (book.autosubscribe || data.books.includes(book.zybook_code)) continue;

		data.books.push(book.zybook_code);
		onAdd('zybook', book.title);
	}

	data.write();
}

export async function getBuildKey() {
	const res = await fetch('https://learn.zybooks.com', {
		headers: {
			'User-Agent': `Mozilla/5.0 (compatible; eedu/${$pkg.version})`,
			Authorization: `Bearer ${data.token}`,
		},
	});
	const content = await res.text();

	// Regex to match: <meta name="zybooks-web/config/environment" content="...">
	const match = content.match(/<meta\s+name=["']zybooks-web\/config\/environment["']\s+content=["']([^"']+)["']/);
	if (!match) throw new Error('Could not find build key');

	const config = JSON.parse(decodeURIComponent(match[1]));
	return config.APP.BUILDKEY;
}

export interface AutoOptions {
	chapter?: number;
	section?: number;
	delay?: number;
}

let buildKey: string;

function createBody(zybook_code: string, resourceId: string, part: number, extra?: object): object {
	const timestamp = new Date().toISOString();
	const md5 = createHash('md5');
	const raw = `content_resource/${resourceId}/activity${timestamp}${data.token}${resourceId}${part}true${buildKey}`;
	md5.update(raw, 'utf8');
	const __cs__ = md5.digest('hex');

	return {
		part,
		complete: true,
		metadata: { isTrusted: true, computerTime: timestamp },
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
		zybooks: [{ chapters }],
	} = await api('GET', `zybooks?zybooks=["${zybook_code}"]`);

	for (const chapter of chapters) {
		if (typeof opts.chapter == 'number' && chapter.number != opts.chapter) continue;

		for (const section of chapter.sections) {
			if (typeof opts.section == 'number' && section.number != opts.section) continue;

			const {
				section: { content_resources },
			} = await api('GET', `zybook/${zybook_code}/chapter/${chapter.number}/section/${section.number}`).catch(() =>
				api('GET', `zybook/${zybook_code}/chapter/${chapter.number}/section/${section.canonical_section_number}`)
			);

			for (const resource of content_resources) {
				if (data.completed_resources.includes(resource.id)) continue;
				switch (resource.type) {
					case 'html':
					case 'container':
						break;
					case 'multiple_choice':
						for (const [part, question] of resource.payload.questions.entries()) {
							const answer = question.choices.find((c: any) => c.correct).label[0].text;
							const body = createBody(zybook_code, resource.id, part, { answer });
							await api('POST', `content_resource/${resource.id}/activity`, body);
							await delay();
						}
						break;
					case 'short_answer':

					case 'custom':
				}
			}
		}
	}
}
