import * as io from 'ioium/node';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { debugMode } from '../config.js';
import { dataDir, dataFrom } from '../data.js';
import { onAdd, prompt, select } from '../discovery.js';

export const QemuData = z.object({
	url: z.url().default('qemu:///session'),
	name: z.string().optional(),
	width: z.int().positive().default(1920),
	height: z.int().positive().default(1080),
	/** Pixels removed from each edge of a screenshot before it is handed to the model */
	crop: z
		.object({
			top: z.int().nonnegative().default(130),
			left: z.int().nonnegative().default(350),
			right: z.int().nonnegative().default(300),
			bottom: z.int().nonnegative().default(0),
		})
		.prefault({}),
	/** Where screenshots and answers are kept */
	dir: z.string().default(join(dataDir, 'qemu')),
	/** Model passed to `claude --model`, if any */
	model: z.string().optional(),
	scroll: z
		.object({
			/**
			 * `key` sends PageDown/PageUp, so it scrolls whatever has keyboard focus.
			 * `wheel` sends mouse wheel clicks over QMP, so it scrolls whatever is under the pointer.
			 * That does not depend on focus, but needs the pointer to already be over the content
			 * and `qemu-monitor-command` to be allowed.
			 */
			method: z.enum(['key', 'wheel']).default('wheel'),
			direction: z.enum(['down', 'up']).default('down'),
			/** Scroll events sent per page */
			count: z.int().positive().default(5),
			/** Milliseconds between scroll events */
			delay: z.int().nonnegative().default(150),
		})
		.prefault({}),
	/** Milliseconds to let the guest repaint after scrolling */
	renderDelay: z.int().nonnegative().default(1000),
});

export interface QemuData extends z.infer<typeof QemuData> {}

export let data = dataFrom('qemu.json', QemuData, QemuData.parse({}));

/** `virsh screenshot` has to round-trip the guest's framebuffer, `claude -p` has to think. */
const timeouts = { virsh: 30_000, claude: 300_000 };

/**
 * Run a command and return its stdout.
 * A tracked "Doing something... done." line for every screenshot, scroll event, and page
 * buries the answers, so the status line is only shown when debugging.
 */
function run(text: string, timeout: number, command: string, ...args: string[]): string {
	if (debugMode) {
		io.setCommandTimeout(timeout);
		return io.trackCommand({ text }, command, ...args);
	}

	try {
		return execFileSync(command, args, { encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e: any) {
		const stderr = typeof e?.stderr == 'string' ? e.stderr.trim() : '';
		throw new Error(stderr.slice(0, 200) || io.errorText(e));
	}
}

function virsh(text: string, ...args: string[]): string {
	return run(text, timeouts.virsh, 'virsh', '-c', data.url, ...args);
}

function domain(): string {
	if (!data.name) throw new Error('No VM configured, run `eedu discover qemu` first');
	return data.name;
}

function assertRunning(): void {
	const state = virsh(`Checking ${domain()}`, 'domstate', domain()).trim();
	if (state != 'running')
		throw new Error(`Domain '${domain()}' is not ${state == 'shut off' ? 'running' : `running (${state})`} on ${data.url}`);
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Capture the guest's screen, crop it, and write it to `path`.
 * Returns the dimensions of the cropped image.
 */
export async function screenshot(path: string): Promise<{ width: number; height: number }> {
	mkdirSync(data.dir, { recursive: true });

	// sharp can not read and write the same file, so the raw capture gets its own path.
	const raw = path + '.raw.png';
	virsh('Capturing screenshot', 'screenshot', domain(), '--file', raw);

	try {
		const image = sharp(raw);
		const { width = 0, height = 0 } = await image.metadata();

		const { top, left, right, bottom } = data.crop;
		const cropped = { width: width - left - right, height: height - top - bottom };

		if (cropped.width <= 0 || cropped.height <= 0)
			throw new Error(`${width}x${height} is too small to crop (${left}+${right} wide, ${top}+${bottom} tall)`);

		await image
			.extract({ left, top, ...cropped })
			.png()
			.toFile(path);
		return cropped;
	} finally {
		rmSync(raw, { force: true });
	}
}

/** Scroll the guest. Whatever has focus (`key`) or is under the pointer (`wheel`) moves. */
export async function scroll(count: number = data.scroll.count): Promise<void> {
	const { method, direction, delay } = data.scroll;

	const key = direction == 'down' ? 'KEY_PAGEDOWN' : 'KEY_PAGEUP';
	const button = direction == 'down' ? 'wheel-down' : 'wheel-up';

	// A wheel click is a press+release of a virtual button.
	const event = JSON.stringify({
		execute: 'input-send-event',
		arguments: {
			events: [
				{ type: 'btn', data: { down: true, button } },
				{ type: 'btn', data: { down: false, button } },
			],
		},
	});

	for (let i = 0; i < count; i++) {
		const text = `Scrolling ${direction}` + (count > 1 ? ` (${i + 1}/${count})` : '');
		try {
			if (method == 'key') virsh(text, 'send-key', domain(), '--codeset', 'linux', '--holdtime', '50', key);
			else virsh(text, 'qemu-monitor-command', domain(), event);
		} catch (e) {
			io.warn('could not scroll:', io.errorText(e));
			return;
		}
		await sleep(delay);
	}
}

function questionPrompt(image: string, explain: boolean): string {
	return `Read the image at ${image}. It is a screenshot of a study-question page.

For every question that is COMPLETELY visible — its number, its full text, and all of its options on screen — output exactly one line:

Q<number>: <the exact text of the correct option>${explain ? ' — <one short sentence of reasoning>' : ''}

Rules:
- Skip any question clipped at the top or bottom of the image; the next
  screenful will show it in full.
- Use the question's own number from the image, not a running count.
- Output only those lines. No preamble, no summary, no markdown fences.
- If the image contains no complete question, output nothing at all.`;
}

/** Ask the model to answer every question fully visible in `image`. */
function answerPage(image: string, explain: boolean): string[] {
	const output = run(
		'Answering questions',
		timeouts.claude,
		'claude',
		'-p',
		questionPrompt(image, explain),
		'--allowed-tools',
		'Read',
		'--output-format',
		'text',
		...(data.model ? ['--model', data.model] : [])
	);

	return output.split('\n').filter(line => /^Q\d+:/.test(line));
}

export async function discover() {
	const url = await prompt('Enter the libvirt connection URI: ', data.url);
	data.url = url.trim() || data.url;

	const dir = await prompt('Enter the directory to keep screenshots and answers in: ', data.dir);
	data.dir = dir.trim() || data.dir;
	mkdirSync(data.dir, { recursive: true });

	const domains = virsh('Listing domains', 'list', '--all', '--name')
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean);

	if (!domains.length) throw new Error(`No domains found on ${data.url}`);

	const name = await select('Select the VM', domains, data.name ?? domains[0]);
	data.name = name.trim() || data.name || domains[0];

	if (!domains.includes(data.name)) throw new Error(`No domain '${data.name}' on ${data.url}`);

	data.write();

	// The only reliable way to learn the guest's resolution is to look at it.
	assertRunning();

	const probe = join(data.dir, 'probe.png');
	virsh('Capturing screenshot', 'screenshot', data.name, '--file', probe);
	try {
		const { width, height } = await sharp(probe).metadata();
		if (!width || !height) throw new Error('Could not read the screenshot dimensions');
		data.width = width;
		data.height = height;
	} finally {
		rmSync(probe, { force: true });
	}

	data.write();

	onAdd('vm', `${data.name} (${data.width}x${data.height})`);

	const { top, left, right, bottom } = data.crop;
	if (data.width - left - right <= 0 || data.height - top - bottom <= 0)
		io.warn(
			`Crop (${left}+${right} wide, ${top}+${bottom} tall) is too large for ${data.width}x${data.height}, edit ${join(dataDir, 'qemu.json')}`
		);
}

export interface AutoOptions {
	/** Stop after this many screenfuls */
	pages: number;
	/** Answer but never scroll, which means a single useful pass */
	scroll: boolean;
	/** Scroll once before the first screenshot, for pages that start above the questions */
	initialScroll: boolean;
	/** Answers file. When unset, answers are only reported through {@link AutoOptions.onAnswer} */
	out?: string;
	/** Ask for a one-line reason with each answer */
	explain: boolean;
	/** Append to an existing answers file, skipping questions already recorded in it. */
	resume: boolean;
	onResume?(count: number, out: string): void;
	onAnswer?(line: string): void;
	onPage?(page: number, added: number, total: number): void;
	onDone?(total: number, out?: string): void;
	onError?(page: number, error: unknown): void;
}

/**
 * Screenshot the guest, answer whatever questions are on screen, scroll, and repeat until the screen stops changing.
 */
export async function autoComplete(opts: AutoOptions) {
	if (!Number.isInteger(opts.pages) || opts.pages < 1) throw new Error('--pages must be a positive integer');

	assertRunning();

	const image = join(data.dir, 'screenshots', 'questions.png');
	const { out } = opts;

	const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
	const pageDir = join(data.dir, 'screenshots', 'pages', runId);
	mkdirSync(pageDir, { recursive: true });

	const seen = new Set<number>();
	if (out && opts.resume && existsSync(out)) {
		for (const [, n] of readFileSync(out, 'utf-8').matchAll(/^Q(\d+)/gm)) seen.add(+n);
		opts.onResume?.(seen.size, out);
	} else if (out) {
		writeFileSync(out, `# Answers — ${runId}\n\n`);
	}

	if (opts.initialScroll) {
		await scroll();
		await sleep(data.renderDelay);
	}

	let previous = '';
	let total = 0;
	let page = 0;

	while (page < opts.pages) {
		page++;

		await screenshot(image);

		const hash = createHash('sha256').update(readFileSync(image)).digest('hex');
		if (hash == previous) {
			io.info(`page ${page}: screen unchanged after scrolling, end of questions`);
			page--;
			break;
		}
		previous = hash;
		copyFileSync(image, join(pageDir, `${page.toString().padStart(3, '0')}.png`));

		let added = 0;
		try {
			for (const line of answerPage(image, opts.explain)) {
				const number = +line.slice(1, line.indexOf(':'));
				if (seen.has(number)) continue;
				seen.add(number);
				if (out) appendFileSync(out, line + '\n\n');
				opts.onAnswer?.(line);
				added++;
			}
		} catch (e) {
			opts.onError?.(page, e);
		}

		total += added;
		opts.onPage?.(page, added, total);

		if (!opts.scroll) break;

		await scroll();
		await sleep(data.renderDelay);
	}

	opts.onDone?.(total, out);
}
