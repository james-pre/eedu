import * as io from 'ioium/node';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import * as llm from '../../llm.js';
import { data } from './data.js';
import { assertRunning } from './domain.js';
import { screenshot, scroll, tempPrefix } from './io.js';

export interface AutoOptions {
	/** Stop after this many screenfuls */
	pages: number;
	/** Answer but never scroll, which means a single useful pass */
	scroll: boolean;
	/** Scroll once before the first screenshot, for pages that start above the questions */
	initialScroll: number;
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

const claudeTimeout = 30_000;

/**
 * Screenshot the guest, answer whatever questions are on screen, scroll, and repeat until the screen stops changing.
 */
export async function autoComplete(opts: AutoOptions) {
	if (!Number.isInteger(opts.pages) || opts.pages < 1) throw new Error('--pages must be a positive integer');

	assertRunning();

	using temp = mkdtempDisposableSync(tempPrefix);
	const image = join(temp.path, 'questions.png');
	const { out } = opts;

	const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').slice(0, 15);

	const seen = new Set<number>();
	if (out && opts.resume && existsSync(out)) {
		for (const [, n] of readFileSync(out, 'utf-8').matchAll(/^Q(\d+)/gm)) seen.add(+n);
		opts.onResume?.(seen.size, out);
	} else if (out) {
		writeFileSync(out, `# Answers — ${runId}\n\n`);
	}

	if (opts.initialScroll) {
		await scroll(opts.initialScroll);
		await setTimeout(data.renderDelay);
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

		let added = 0;
		try {
			const output = await llm.ask(
				llm.prompt('qemu-questions', { image, explain: opts.explain ? ' — <one short sentence of reasoning>' : '' }),
				{ tools: ['Read'], cwd: temp.path, timeout: claudeTimeout }
			);

			for (const line of output.split('\n').filter(line => /^Q\d+:/.test(line))) {
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
		await setTimeout(data.renderDelay);
	}

	opts.onDone?.(total, out);
}
