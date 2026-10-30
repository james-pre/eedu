import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ContentResource, TestCase } from './types.js';

const exec = promisify(execFile);

interface Run {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
}

/** Run a program with `input` on its standard input, killing it if it takes longer than `timeout` */
function run(command: string, args: string[], cwd: string, input: string, timeout: number): Promise<Run> {
	const { promise, resolve, reject } = Promise.withResolvers<Run>();
	const child = spawn(command, args, { cwd });

	let stdout = '';
	let stderr = '';
	let timedOut = false;

	const timer = setTimeout(() => {
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

/** How a source file is built and run, by extension */
const languages: Record<string, { name: string; build?(file: string): string[]; run(file: string): string[] }> = {
	'.c': { name: 'C', build: file => ['gcc', '-std=c11', '-Wall', file, '-o', 'program', '-lm'], run: () => ['./program'] },
	'.cpp': { name: 'C++', build: file => ['g++', '-std=c++17', '-Wall', file, '-o', 'program'], run: () => ['./program'] },
	'.py': { name: 'Python', run: file => ['python3', file] },
	'.java': { name: 'Java', build: file => ['javac', file], run: file => ['java', basename(file, '.java')] },
	'.js': { name: 'JavaScript', run: file => ['node', file] },
};

export const languageOf = (file: string): string | undefined => languages[extname(file)]?.name;

/** Text as it is compared, which ignores line ending and trailing whitespace differences */
function normalize(text: string, { ignoreCase, ignoreWhitespace }: TestCase['stdoutCompareOptions']): string {
	let result = text.replaceAll('\r\n', '\n').replace(/\s+$/, '');
	if (ignoreWhitespace) result = result.replaceAll(/\s+/g, ' ').trim();
	if (ignoreCase) result = result.toLowerCase();
	return result;
}

function passes(output: string, test: TestCase): boolean {
	const options = test.stdoutCompareOptions ?? { ignoreCase: false, ignoreWhitespace: false };
	const actual = normalize(output, options);
	const expected = normalize(test.stdout, options);
	if (test.stdoutCompareMethod == 'starts_with') return actual.startsWith(expected);
	if (test.stdoutCompareMethod == 'contains') return actual.includes(expected);
	return actual == expected;
}

export interface TestResult {
	test: TestCase;
	passed: boolean;
	points: number;
	output: string;
	error?: string;
}

/** The first line where the output differs from what was expected */
export function firstDifference(output: string, expected: string): string | undefined {
	const actual = output.replaceAll('\r\n', '\n').split('\n');
	const wanted = expected.replaceAll('\r\n', '\n').split('\n');

	for (let i = 0; i < Math.max(actual.length, wanted.length); i++) {
		if (actual[i] === wanted[i]) continue;
		return `line ${i + 1}: expected ${JSON.stringify(wanted[i] ?? '')}, got ${JSON.stringify(actual[i] ?? '')}`;
	}
}

/**
 * Build `file` and run it once per test case, comparing its output the way the lab does.
 * Everything runs inside `dir`, which is where the student's work for the lab is.
 */
export async function runTests(dir: string, file: string, tests: TestCase[], timeout: number = 10_000): Promise<TestResult[]> {
	const language = languages[extname(file)];
	if (!language) throw new Error(`Cannot run ${file}, only ${Object.keys(languages).join(', ')} files are supported`);
	if (!existsSync(join(dir, file))) throw new Error(`${file} does not exist yet`);

	if (language.build) {
		const [command, ...args] = language.build(file);
		await exec(command, args, { cwd: dir, timeout }).catch((e: { stderr?: string; message: string }) => {
			throw new Error(`${language.name} build failed:\n` + (e.stderr || e.message));
		});
	}

	const [command, ...args] = language.run(file);
	const results: TestResult[] = [];

	for (const test of tests) {
		const extra = test.argStr ? test.argStr.split(/\s+/) : [];
		const { stdout, stderr, code, timedOut } = await run(command, [...args, ...extra], dir, test.stdin ?? '', timeout);

		const error = timedOut
			? `timed out after ${timeout / 1000}s, so it is probably waiting for input it was not given`
			: code
				? `exited with code ${code}` + (stderr ? ': ' + stderr.trim() : '')
				: undefined;

		const passed = !error && passes(stdout, test);
		results.push({ test, passed, points: passed ? test.points : 0, output: stdout, error });
	}

	return results;
}

/** A programming lab's test cases, in the order they are shown */
export function labTests(resource: ContentResource): TestCase[] {
	return [...(resource.payload.testCases ?? [])].sort((a, b) => (a.sortWeight ?? 0) - (b.sortWeight ?? 0));
}
