import { join } from 'node:path/posix';
import * as z from 'zod';
import $pkg from '../../package.json' with { type: 'json' };
import { dataDir } from '../data.js';
import { readJSON, writeJSON } from '../utils.js';

const dataPath = join(dataDir, 'canvas.json');

export const CanvasData = z
	.object({
		token: z.string(),
		origin: z.url(),
	})
	.partial();

export interface CanvasData extends z.infer<typeof CanvasData> {}

export let data: CanvasData;
try {
	data = readJSON(dataPath, CanvasData);
} catch {
	data = {};
}

export function writeData() {
	writeJSON(dataPath, data);
}

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
		throw message ?? new Error(`${method} ${endpoint} request failed: ` + response.statusText);
	}

	return json;
}
