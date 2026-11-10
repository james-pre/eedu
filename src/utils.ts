import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { debugMode } from './config.js';
import * as io from 'ioium/node';

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
}

export interface RunOptions {
	cwd?: string;
	/** Written to the program's standard input */
	input?: string;
	/** Milliseconds before the program is killed */
	timeout?: number;
}

/** Run a program to completion. A non-zero exit code is reported in the result, not thrown. */
export function run(command: string, args: string[], { cwd, input = '', timeout }: RunOptions = {}): Promise<RunResult> {
	const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
	const child = spawn(command, args, { cwd });

	let stdout = '';
	let stderr = '';
	let timedOut = false;

	const timer =
		timeout === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					child.kill('SIGKILL');
				}, timeout);

	child.stdout.on('data', chunk => (stdout += chunk));
	child.stderr.on('data', chunk => (stderr += chunk));
	child.on('error', error => {
		clearTimeout(timer);
		reject(error);
	});
	child.on('close', code => {
		clearTimeout(timer);
		resolve({ stdout, stderr, code, timedOut });
	});

	child.stdin.on('error', () => {});
	child.stdin.end(input);

	return promise;
}

/**
 * A tracked "Doing something... done." line for every screenshot, scroll event, and page
 * buries the answers, so the status line is only shown when debugging.
 */
export function runSync(text: string, timeout: number, command: string, ...args: string[]): string {
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

/**
 * Throw `message` if `promise` has not settled in time.
 * @param timeout In seconds
 */
export async function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
	const timedOut = Symbol('timeout');
	const result = await Promise.race([promise, sleep(timeout * 1000, timedOut, { ref: false })]);
	if (result === timedOut) throw new Error(message);
	return result as T;
}

/**
 * Works without specifying protocol, etc.
 */
export function normalizeURL(url: string): URL {
	if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
	return new URL(url);
}
