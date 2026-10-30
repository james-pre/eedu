import { Manager } from '@james-pre/config';
import { join } from 'node:path';
import * as z from 'zod';
import $pkg from '../../../package.json' with { type: 'json' };
import { dataDir } from '../../data.js';

export const ZybooksData = z.object({
	token: z.string().nullish(),
	user_id: z.int().optional(),
	books: z.string().array().default([]),
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
export function itlabs<T = any>(method: string, endpoint: string, body?: any): Promise<T> {
	const headers: Record<string, string> = body === undefined ? {} : { 'Content-Type': 'application/json' };
	return request<T>('https://itlabs-server.zybooks.com/v1/', method, endpoint, body, headers);
}
