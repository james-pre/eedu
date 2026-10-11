import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempDisposableSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const exec = promisify(execFile);

const execOptions = { timeout: 180_000, maxBuffer: 64 << 20 };

const tempPrefix = join(tmpdir(), 'eedu-');

/** Uses its own profile so conversions work while LibreOffice is open */
const libreOfficeProfile = 'file://' + join(tmpdir(), 'eedu-libreoffice');

/** Convert a file with LibreOffice into `outDir`, returning the paths it wrote */
async function libreOffice(path: string, format: string, outDir: string): Promise<string[]> {
	await exec(
		'soffice',
		[`-env:UserInstallation=${libreOfficeProfile}`, '--headless', '--convert-to', format, '--outdir', outDir, path],
		execOptions
	);
	const stem = basename(path, extname(path));
	const outputs = readdirSync(outDir)
		.filter(name => name.startsWith(stem))
		.map(name => join(outDir, name));
	if (!outputs.length) throw new Error(`LibreOffice could not convert ${basename(path)} to ${format.split(':')[0]}`);
	return outputs;
}

const ext = (path: string) => extname(path).toLowerCase();

const pandocReadable = ['.docx', '.odt', '.rtf', '.html', '.htm', '.epub'];
const slides = ['.pptx', '.ppt', '.odp'];
const spreadsheets = ['.xlsx', '.xls', '.ods'];
const markdown = ['.md', '.markdown'];

/** Build a PDF next to a Markdown file with pandoc, returning the PDF's path */
export async function buildPdf(path: string): Promise<string> {
	const pdf = join(dirname(path), basename(path, extname(path)) + '.pdf');
	await exec('pandoc', [basename(path), '-o', pdf, ...config.pandoc], { ...execOptions, cwd: dirname(path) });
	return pdf;
}

/** The text of a document: Markdown for word processor files, CSV for spreadsheets, and plain text otherwise */
export async function readDocument(path: string): Promise<string> {
	const type = ext(path);
	if (type == '.pdf') return (await exec('pdftotext', ['-layout', path, '-'], execOptions)).stdout;
	if (pandocReadable.includes(type)) return (await exec('pandoc', [path, '-t', 'markdown', '--wrap=none'], execOptions)).stdout;

	if (slides.includes(type)) {
		using temp = mkdtempDisposableSync(tempPrefix);
		const [pdf] = await libreOffice(path, 'pdf', temp.path);
		return (await exec('pdftotext', ['-layout', pdf, '-'], execOptions)).stdout;
	}

	if (spreadsheets.includes(type)) {
		using temp = mkdtempDisposableSync(tempPrefix);
		const sheets = await libreOffice(path, 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1', temp.path);
		return sheets.map(sheet => `# ${basename(sheet, '.csv')}\n\n${readFileSync(sheet, 'utf8')}`).join('\n\n');
	}

	return readFileSync(path, 'utf8');
}

/** Convert a document into the format of `output`'s extension */
export async function convertDocument(input: string, output: string): Promise<void> {
	const from = ext(input);
	const to = ext(output);

	if (markdown.includes(from) && to == '.pdf') {
		copyFileSync(await buildPdf(input), output);
		return;
	}

	if (markdown.includes(from) || pandocReadable.includes(from)) {
		await exec('pandoc', [input, '-o', output, ...(markdown.includes(from) ? [config.pandoc[0]] : [])], execOptions);
		return;
	}

	using temp = mkdtempDisposableSync(tempPrefix);
	const [converted] = await libreOffice(input, to.slice(1), temp.path);
	copyFileSync(converted, output);
}

export interface Rendered {
	/** PNG images of the rendered pages */
	pages: Buffer[];
	total: number;
}

/** Render pages of a document as images, building Markdown with pandoc first */
export async function renderDocument(path: string, first: number = 1, count: number = 5): Promise<Rendered> {
	using temp = mkdtempDisposableSync(tempPrefix);
	const type = ext(path);
	const pdf = type == '.pdf' ? path : markdown.includes(type) ? await buildPdf(path) : (await libreOffice(path, 'pdf', temp.path))[0];

	const total = Number((await exec('pdfinfo', [pdf], execOptions)).stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
	const last = Math.min(total, first + count - 1);
	await exec('pdftoppm', ['-png', '-r', '70', '-f', String(first), '-l', String(last), pdf, join(temp.path, 'page')], execOptions);

	const pages = readdirSync(temp.path)
		.filter(name => name.startsWith('page') && name.endsWith('.png'))
		.sort()
		.map(name => readFileSync(join(temp.path, name)));
	return { pages, total };
}

const unpackedDir = (path: string) => join(dirname(path), `.${basename(path)}.parts`);

/**
 * Extract an Office Open XML file (.docx, .pptx, .xlsx) so its XML can be edited.
 * @returns The directory and the XML parts in it
 */
export async function unpackOffice(path: string): Promise<{ dir: string; parts: string[] }> {
	const dir = unpackedDir(path);
	rmSync(dir, { recursive: true, force: true });
	await exec('unzip', ['-q', '-o', path, '-d', dir], execOptions);

	const parts: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(xml|rels)$/.test(entry.name)) parts.push(relative(dir, full));
		}
	};
	walk(dir);
	return { dir, parts };
}

/**
 * Zip a directory from {@link unpackOffice} into `output`.
 * The first time an existing file is replaced, it's kept as `.<name>.orig<ext>`.
 */
export async function packOffice(dir: string, output: string): Promise<void> {
	const backup = join(dirname(output), `.${basename(output, extname(output))}.orig${extname(output)}`);
	if (existsSync(output) && !existsSync(backup)) copyFileSync(output, backup);

	using temp = mkdtempDisposableSync(tempPrefix);
	const zip = join(temp.path, 'out.zip');
	await exec('zip', ['-X', '-r', '-q', zip, '.'], { ...execOptions, cwd: dir });
	copyFileSync(zip, output);
}

const placeholderPattern = /\[(?:TODO|INSERT)\b[^\]]*\]/gi;

/** Placeholders like `[TODO: ...]` or `[INSERT ...]` left in text */
export function textPlaceholders(text: string): string[] {
	return [...text.matchAll(placeholderPattern)].map(([match]) => match.replaceAll('\\', ''));
}

/** Placeholders like `[TODO: ...]` or `[INSERT ...]` left in a document */
export async function placeholders(path: string): Promise<string[]> {
	return textPlaceholders(await readDocument(path));
}
