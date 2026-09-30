import { Manager } from '@james-pre/config';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';

export const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'eedu');
mkdirSync(dataDir, { recursive: true });

export const Term = z.object({
	id: z.string(),
	name: z.string(),
	start: z.coerce.date(),
	end: z.coerce.date(),
	canvas_id: z.int().optional(),
});

export interface Term extends z.infer<typeof Term> {}

export const Course = z.object({
	id: z.string(),
	name: z.string(),
	term: z.string(),
	canvas_id: z.int().optional(),
});

export interface Course extends z.infer<typeof Course> {}

export const School = z.object({
	terms: Term.array().default([]),
	courses: Course.array().default([]),
});

export interface School extends z.infer<typeof School> {}

export const school = new Manager(School);
school.loadFile(join(dataDir, 'school.json'), { create: true });
