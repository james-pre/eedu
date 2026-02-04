import * as z from 'zod';
import $pkg from '../../package.json' with { type: 'json' };
import { dataFrom } from '../data.js';
import { onAdd, prompt } from '../discovery.js';

export const ZybooksData = z
	.object({
		token: z.string(),
		user_id: z.int(),
		books: z.string().array(),
	})
	.partial();

export interface ZybooksData extends z.infer<typeof ZybooksData> {}

export let data = dataFrom('zybooks.json', ZybooksData, {});

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

	data.books ||= [];

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

export async function getChapters(zybook_code: string): Promise<any> {
	const {
		zybooks: [book],
	} = await api('GET', `zybooks?zybooks=["${zybook_code}"]`);

	return book.chapters;
}
