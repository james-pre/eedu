import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { readJSON, writeJSON } from './utils.js';

export const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'eedu');
mkdirSync(dataDir, { recursive: true });

export type DataFrom<S extends z.ZodType> = z.infer<S> & {
	write(): void;
};

export function dataFrom<const S extends z.ZodObject | z.ZodArray>(path: string, schema: S, defaultValue?: z.infer<S>): DataFrom<S> {
	path = join(dataDir, path);
	let data: z.infer<S>;
	try {
		data = readJSON<any>(path, schema);
	} catch {
		if (!defaultValue) throw new Error('No default value for data');
		data = defaultValue;
	}

	return Object.assign(data, {
		write() {
			writeJSON(path, data);
		},
	});
}

export const Term = z.object({
	id: z.string(),
	name: z.string(),
	start: z.coerce.date(),
	end: z.coerce.date(),
	canvas_id: z.int().optional(),
});

export interface Term extends z.infer<typeof Term> {}

export const terms = dataFrom('terms.json', Term.array(), []);

export const Course = z.object({
	id: z.string(),
	name: z.string(),
	term: z.string(),
	canvas_id: z.int().optional(),
});

export interface Course extends z.infer<typeof Course> {}

export const courses = dataFrom('courses.json', Course.array(), []);
