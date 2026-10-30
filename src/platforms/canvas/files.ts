import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { Attachment } from '../../assignments.js';
import type { Course } from '../../data.js';
import { api, data } from './api.js';

interface UploadTarget {
	upload_url: string;
	upload_params: Record<string, string>;
}

/**
 * Upload a file using Canvas' file upload process.
 * @returns The ID of the uploaded file
 */
export async function upload(endpoint: string, path: string): Promise<number> {
	const file = await openAsBlob(path);
	const name = basename(path);
	const { upload_url, upload_params } = await api<UploadTarget>('POST', endpoint, { name, size: file.size });

	const form = new FormData();
	for (const [key, value] of Object.entries(upload_params)) form.append(key, value);
	form.append('file', file, name);

	const response = await fetch(upload_url, { method: 'POST', body: form, redirect: 'manual' });
	const location = response.headers.get('Location');
	if (location && (response.status == 201 || (response.status >= 300 && response.status < 400)))
		return (await api<{ id: number }>('GET', location)).id;
	if (!response.ok) throw new Error(`Uploading ${name} failed: ` + response.statusText);
	return ((await response.json()) as { id: number }).id;
}

export interface CanvasFile {
	id: number;
	display_name: string;
	url: string;
}

/** IDs of the files linked from HTML */
export const fileIds = (html: string) => [...html.matchAll(/\/files\/(\d+)/g)].map(match => Number(match[1]));

/** Files linked from HTML, such as an assignment description */
export async function linkedFiles(course: Course, html: string): Promise<Attachment[]> {
	const files = await Promise.all(
		[...new Set(fileIds(html))].map(id => api<CanvasFile>('GET', `courses/${course.canvas_id}/files/${id}`))
	);
	return files.map(attachment);
}

export function attachment(file: CanvasFile): Attachment {
	return {
		name: file.display_name,
		async download() {
			const response = await fetch(file.url, { headers: { Authorization: `Bearer ${data.token}` } });
			if (!response.ok) throw new Error(`Downloading ${file.display_name} failed: ` + response.statusText);
			return new Uint8Array(await response.arrayBuffer());
		},
	};
}
