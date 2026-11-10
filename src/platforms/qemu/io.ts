import * as io from 'ioium/node';
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import sharp from 'sharp';
import { debugMode } from '../../config.js';
import { data, name as domain } from './data.js';

/**
 * Capture the guest's screen, crop it, and write it to `path`.
 * Returns the dimensions of the cropped image.
 */
export async function screenshot(path: string): Promise<{ width: number; height: number }> {
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
		await setTimeout(delay);
	}
}

/** Linux key names for each character on a US layout */
const usLayout = new Map<string, string[]>([
	[' ', ['KEY_SPACE']],
	['\n', ['KEY_ENTER']],
	['\t', ['KEY_TAB']],
]);

for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
	const key = 'KEY_' + letter.toUpperCase();
	usLayout.set(letter, [key]);
	usLayout.set(letter.toUpperCase(), ['KEY_LEFTSHIFT', key]);
}

for (const [key, plain, shifted] of [
	['1', '1', '!'],
	['2', '2', '@'],
	['3', '3', '#'],
	['4', '4', '$'],
	['5', '5', '%'],
	['6', '6', '^'],
	['7', '7', '&'],
	['8', '8', '*'],
	['9', '9', '('],
	['0', '0', ')'],
	['GRAVE', '`', '~'],
	['MINUS', '-', '_'],
	['EQUAL', '=', '+'],
	['LEFTBRACE', '[', '{'],
	['RIGHTBRACE', ']', '}'],
	['BACKSLASH', '\\', '|'],
	['SEMICOLON', ';', ':'],
	['APOSTROPHE', "'", '"'],
	['COMMA', ',', '<'],
	['DOT', '.', '>'],
	['SLASH', '/', '?'],
]) {
	usLayout.set(plain, ['KEY_' + key]);
	usLayout.set(shifted, ['KEY_LEFTSHIFT', 'KEY_' + key]);
}

const virshTimeout = 30_000;

/**
 * Send key combinations through one virsh process.
 * QEMU queues them behind each other, each held for {@link QemuData.keyHold}, so this returns before the guest has received them all.
 */
function sendKeys(text: string, combinations: string[][]): void {
	const name = '"' + domain().replace(/["\\]/g, '\\$&') + '"';
	const commands = combinations.map(keys => `send-key ${name} --codeset linux --holdtime ${data.keyHold} ${keys.join(' ')}`);

	io.debug(text);

	const result = spawnSync('virsh', ['-q', '-c', data.url], {
		input: commands.join('\n') + '\n',
		encoding: 'utf-8',
		timeout: virshTimeout,
	});
	const error = result.error ?? result.stderr.match(/^error: .*/m)?.[0];
	if (error) throw new Error(`${text} failed: ${error}`);
}

/** Press a key combination, e.g. `press('KEY_LEFTCTRL', 'KEY_L')` */
export async function press(...keys: string[]): Promise<void> {
	sendKeys(`Pressing ${keys.join('+')}`, [keys]);
	await setTimeout(data.keyHold);
}

/** Type text into whatever has focus in the guest, assuming the guest uses a US keyboard layout. */
export async function typeText(text: string): Promise<void> {
	const characters = [...text];
	const unsupported = [...new Set(characters.filter(character => !usLayout.has(character)))];
	if (unsupported.length) throw new Error('Can not type ' + unsupported.map(character => JSON.stringify(character)).join(', '));

	sendKeys(
		`Typing ${characters.length} characters`,
		characters.map(character => usLayout.get(character)!)
	);
	await setTimeout(characters.length * data.keyHold);
}

/** Screenshots are kept here only while they're being used */
export const tempPrefix = join(tmpdir(), 'eedu-qemu-');

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

export function virsh(text: string, ...args: string[]): string {
	return run(text, virshTimeout, 'virsh', '-c', data.url, ...args);
}
