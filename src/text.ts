import { marked, type MarkedToken, type Token } from 'marked';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { stripVTControlCharacters, styleText } from 'node:util';

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

const visibleLength = (text: string) => stripVTControlCharacters(text).length;

function inline(tokens: Token[] = []): string {
	return (tokens as MarkedToken[])
		.map(token => {
			switch (token.type) {
				case 'strong':
					return styleText('bold', inline(token.tokens));
				case 'em':
					return styleText('italic', inline(token.tokens));
				case 'del':
					return styleText('strikethrough', inline(token.tokens));
				case 'codespan':
					return styleText('cyan', token.text);
				case 'link': {
					const text = inline(token.tokens);
					return text == token.href
						? styleText('underline', text)
						: styleText('underline', text) + styleText('dim', ` (${token.href})`);
				}
				case 'text':
					return token.tokens ? inline(token.tokens) : token.text;
				case 'escape':
				case 'html':
					return token.text;
				case 'br':
					return '\n';
				case 'checkbox':
					return '';
				default:
					return token.raw;
			}
		})
		.join('');
}

/** Word-wrap text to `width` columns, prefixing the first line with `first` and the others with spaces of the same width */
function wrap(text: string, width: number, first: string = ''): string[] {
	const indent = ' '.repeat(visibleLength(first));
	const room = width - indent.length;
	const lines: string[] = [];
	for (const paragraph of text.split('\n')) {
		let line = '';
		for (const word of paragraph.split(' ')) {
			if (line && visibleLength(line) + 1 + visibleLength(word) > room) {
				lines.push(line);
				line = word;
			} else line += (line ? ' ' : '') + word;
		}
		lines.push(line);
	}
	return lines.map((line, i) => (i ? indent : first) + line);
}

function table(token: Extract<MarkedToken, { type: 'table' }>): string[] {
	const rows = [token.header, ...token.rows].map(row => row.map(cell => inline(cell.tokens)));
	const widths = token.header.map((_, i) => Math.max(...rows.map(row => visibleLength(row[i] ?? ''))));
	const line = (row: string[]) =>
		row
			.map((cell, i) => cell + ' '.repeat(widths[i] - visibleLength(cell)))
			.join('  ')
			.trimEnd();
	const [header, ...body] = rows;
	return [styleText('bold', line(header)), styleText('dim', widths.map(w => '─'.repeat(w)).join('  ')), ...body.map(line)];
}

function blocks(tokens: Token[], width: number): string[] {
	const lines: string[] = [];
	const add = (rendered: string[]) => lines.push(...rendered);
	for (const token of tokens as MarkedToken[]) {
		switch (token.type) {
			case 'space':
				if (lines.length && token != tokens.at(-1)) lines.push('');
				break;
			case 'checkbox':
				break;
			case 'heading':
				add(wrap(styleText(token.depth == 1 ? ['bold', 'underline'] : 'bold', inline(token.tokens)), width));
				break;
			case 'paragraph':
			case 'text':
				add(wrap(inline(token.tokens ?? [token]), width));
				break;
			case 'list': {
				const start = Number(token.start) || 1;
				const markerWidth = token.ordered ? String(start + token.items.length - 1).length + 1 : 1;
				add(
					token.items.flatMap((item, i) => {
						const marker = token.ordered ? `${start + i}.`.padStart(markerWidth) : '•';
						const prefix = marker + ' ' + (item.task ? (item.checked ? '[x] ' : '[ ] ') : '');
						const indent = ' '.repeat(prefix.length);
						const lines = blocks(item.tokens, width - prefix.length).map((line, j) => (j ? indent : prefix) + line);
						return token.loose && i ? ['', ...lines] : lines;
					})
				);
				break;
			}
			case 'code':
				add(token.text.split('\n').map(line => '    ' + styleText('cyan', line)));
				break;
			case 'blockquote':
				add(blocks(token.tokens, width - 2).map(line => styleText('dim', '│ ') + line));
				break;
			case 'hr':
				add([styleText('dim', '─'.repeat(Math.min(width, 40)))]);
				break;
			case 'table':
				add(table(token));
				break;
			case 'html':
				add(token.text.trimEnd().split('\n'));
				break;
			default:
				add(token.raw.trimEnd().split('\n'));
		}
	}
	return lines;
}

/** Markdown styled for a terminal and word-wrapped to `width` columns */
export function markdownToTerminal(markdown: string, width: number = process.stdout.columns || Infinity): string {
	return blocks(marked.lexer(markdown, { gfm: true }), width).join('\n');
}
