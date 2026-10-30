import type { Attachment } from '../../assignments.js';
import type { Course } from '../../data.js';
import { api, apiAll } from './api.js';
import { attachment, fileIds, type CanvasFile } from './files.js';
import type * as types from './types.js';

export interface Syllabus {
	/** HTML of the course's syllabus, description, and home page, and of pages titled like a syllabus */
	pages: { title: string; html: string }[];
	/** Files titled like a syllabus, and files linked from the pages */
	files: Attachment[];
}

/** Everything in the course that looks like its syllabus */
export async function syllabus(course: Course): Promise<Syllabus> {
	const base = `courses/${course.canvas_id}`;
	const { syllabus_body, public_description } = await api<types.Course>(
		'GET',
		base + '?include[]=syllabus_body&include[]=public_description'
	);
	const pages = syllabus_body ? [{ title: 'Syllabus', html: syllabus_body }] : [];
	if (public_description) pages.push({ title: 'Course description', html: public_description });

	// Courses without a front page answer 404.
	const front = await api<{ title: string; body: string | null }>('GET', base + '/front_page').catch(() => undefined);
	if (front?.body) pages.push({ title: front.title, html: front.body });

	const ids = new Set<number>();

	for (const module of await apiAll<types.Module>(base + '/modules?include[]=items').catch(() => [])) {
		module.items ||= await apiAll<types.ModuleItem>(module.items_url);
		for (const item of module.items) {
			if (!/syllabus/i.test(item.title)) continue;
			if (item.type == 'File' && item.content_id) ids.add(item.content_id);
			if (item.type != 'Page' || !item.page_url) continue;
			const page = await api<{ title: string; body: string | null }>('GET', `${base}/pages/${item.page_url}`);
			pages.push({ title: page.title, html: page.body ?? '' });
		}
	}

	for (const page of pages) for (const id of fileIds(page.html)) ids.add(id);

	// Students often can't list a course's files, so a failed search just finds nothing.
	const found = await apiAll<CanvasFile>(base + '/files?search_term=syllabus').catch(() => []);
	const files = new Map(found.map(file => [file.id, file]));
	for (const id of ids) {
		if (files.has(id)) continue;
		// Pages can link files that were deleted or hidden, which shouldn't hide the rest.
		const file = await api<CanvasFile>('GET', `${base}/files/${id}`).catch(() => undefined);
		if (file) files.set(id, file);
	}

	const documents = [...files.values()].filter(file => !/\.(png|jpe?g|gif|svg|webp)$/i.test(file.display_name));
	return { pages, files: documents.map(attachment) };
}
