import { readFileSync, writeFileSync } from 'node:fs';
import { $ZodError, prettifyError } from 'zod/v4/core';
import type * as z from 'zod';

/**
 * Works without specifying protocol, etc.
 */
export function normalizeURL(url: string): URL {
	if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
	return new URL(url);
}

export function errorText(error: unknown): string {
	if (error instanceof $ZodError) return prettifyError(error);
	if (error instanceof Error) return error.message;
	return String(error);
}

export function readJSON<S extends z.ZodType>(path: string, schema: S): z.infer<S> {
	try {
		const data = JSON.parse(readFileSync(path, 'utf-8'));
		return schema.parse(data);
	} catch (e) {
		throw errorText(e);
	}
}

export function writeJSON(path: string, data: any) {
	writeFileSync(
		path,
		JSON.stringify(data, null, 4).replaceAll(/^( {4})+/g, match => '\t'.repeat(match.length / 4)),
		'utf-8'
	);
}
