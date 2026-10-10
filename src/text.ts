import { marked } from 'marked';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export const textFormats = ['text', 'markdown', 'html'] as const;

export type TextFormat = (typeof textFormats)[number];

export interface Text {
	content: string;
	format: TextFormat;
}

const extensionFormats: Record<string, TextFormat> = {
	'.md': 'markdown',
	'.markdown': 'markdown',
	'.html': 'html',
	'.htm': 'html',
};

/** The format of a file from its extension, defaulting to plain text */
export function formatOf(path: string): TextFormat {
	return extensionFormats[extname(path).toLowerCase()] ?? 'text';
}

/**
 * Read text from a file, or standard input when `path` is `-`.
 * @param format Defaults to the format of the file's extension
 */
export function readText(path: string, format?: TextFormat): Text {
	return { content: readFileSync(path == '-' ? 0 : path, 'utf8'), format: format ?? formatOf(path) };
}

export function escapeHTML(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toHTML({ content, format }: Text): string {
	switch (format) {
		case 'html':
			return content;
		case 'markdown':
			return marked(content, { async: false, gfm: true });
		case 'text':
			return escapeHTML(content).replace(/\r?\n/g, '<br>');
	}
}

const htmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** A rough plain text rendering of HTML for display */
export function htmlToText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|h\d)>/gi, '\n')
		.replace(/<li[^>]*>/gi, '- ')
		.replace(/<[^>]+>/g, '')
		.replace(/&(\w+|#\d+);/g, (entity, name) => htmlEntities[name] ?? entity)
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
