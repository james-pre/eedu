import { join } from 'node:path/posix';
import * as z from 'zod';
import { dataDir } from '../data.js';
import { readJSON, writeJSON } from '../utils.js';

const dataPath = join(dataDir, 'zybooks.json');

export const ZybooksData = z
	.object({
		token: z.string(),
	})
	.partial();

export interface ZybooksData extends z.infer<typeof ZybooksData> {}

export let data: ZybooksData;
try {
	data = readJSON(dataPath, ZybooksData);
} catch {
	data = {};
}

export function writeData() {
	writeJSON(dataPath, data);
}

export async function discover() {}
