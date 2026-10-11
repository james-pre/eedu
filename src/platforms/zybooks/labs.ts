import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import $pkg from '../../../package.json' with { type: 'json' };
import { firstDifference, languageOf, runTests } from './code.js';
import { dataDir } from '../../data.js';
import { prompt, runAgent, within, type AgentOptions, type AgentResult } from '../../llm.js';
import * as zybooks from '../zybooks.js';
import * as studio from './studio.js';
import { htmlToText } from '../../text.js';
import { Screen } from '../../vnc.js';

/** Where the agent keeps notes while working through a lab */
const labDir = join(dataDir, 'labs');

const textResult = (text: string, isError: boolean = false) => ({ content: [{ type: 'text' as const, text }], isError });

const readOnly = { annotations: { readOnlyHint: true } };

/** Lab instructions read as prose, since they are written for a web page */
function plain(text: string): string {
	return text
		.replaceAll(/<br\s*\/?>/gi, '\n')
		.replaceAll('***', '')
		.replaceAll(/\n{3,}/g, '\n\n')
		.trim();
}

/** Points earned for each goal, in the same order */
function earned(goals: zybooks.Goal[], parts: number[]): number[] {
	let offset = 0;
	return goals.map(goal => {
		const slice = parts.slice(offset, offset + goal.points);
		offset += goal.points;
		return slice.reduce((sum, part) => sum + part, 0);
	});
}

const goalText = (goal: zybooks.Goal, vms: zybooks.VmImage[]) =>
	`- Goal ${goal.index} (${goal.points} points, checked on ${vms[goal.instance]?.title}): ${plain(goal.message)}`
	+ `\n  Checked with: ${goal.vmImageTests[goal.instance]?.command}`;

/** A lab's pages, steps, and goals as Markdown */
export function labText(resource: zybooks.ContentResource): string {
	const vms = resource.payload.vmImages ?? [];
	const goals = zybooks.labGoals(resource);
	const lines: string[] = [];
	let page = 0;
	let goal = 0;

	for (const item of resource.payload.items ?? []) {
		if (zybooks.isPage(item)) lines.push('', `## Page ${++page}`, '', plain(item.instructions));
		else if (zybooks.isStep(item)) lines.push('', `### Step ${item.number}`, '', plain(item.instructions));
		else lines.push('', goalText(goals[goal++], vms));
	}

	return lines.join('\n').trim();
}

export interface LabOptions extends Omit<AgentOptions, 'dir' | 'readable' | 'writable' | 'mcpServers' | 'allowedTools' | 'askTools'> {
	/** Extra instructions from the student */
	instructions?: string;
	/** Do the lab again even when every point has been earned */
	force?: boolean;
	onStatus?(text: string): void;
}

export interface LabResult extends AgentResult {
	points: number;
	possible: number;
	/** Whether zyBooks recorded the points, which only happens for IT labs */
	recorded: boolean;
	/** Where Claude's work is, for labs the student submits themselves */
	dir?: string;
}

/** Have Claude work through a lab, on VMs for an IT lab or as code for a programming lab */
export function lab(lab: zybooks.Lab, options: LabOptions): Promise<LabResult> {
	return zybooks.isItLab(lab.resource) ? itLab(lab, options) : codeLab(lab, options);
}

/**
 * Have Claude work through an IT lab on its VMs.
 * The VMs are started before the agent runs and deleted once it is done, since they are billed for as long as they run.
 */
export async function itLab(lab: zybooks.Lab, options: LabOptions): Promise<LabResult> {
	const { zybook_code, zybook_id, resource } = lab;
	const status = (text: string) => options.onStatus?.(text);

	const vms = resource.payload.vmImages ?? [];
	const goals = zybooks.labGoals(resource);
	const possible = goals.reduce((sum, goal) => sum + goal.points, 0);
	if (!goals.length) throw new Error(lab.name + ' has no graded goals');

	const before = earned(goals, await zybooks.labCompletion(zybook_code, resource.id));
	const points = before.reduce((sum, p) => sum + p, 0);
	if (points == possible && !options.force) {
		status(`${lab.name} already has all ${possible} points`);
		return { text: 'Already complete', sessionId: '', cost: 0, points, possible, recorded: true };
	}

	const dir = join(labDir, `${zybook_code}-${resource.id}`);
	mkdirSync(dir, { recursive: true });

	status(`Starting ${vms.length} VM(s) for ${lab.name}, which takes a few minutes`);
	const urls = await zybooks.startLab(zybook_code, resource.id);

	const screens: Screen[] = [];
	let current = 0;

	const screen = (): Screen => {
		const active = screens[current];
		if (!active) throw new Error('No VM is connected');
		return active;
	};

	/** Point the following tool calls at a VM, by its title */
	const select = (title: string): number => {
		const index = vms.findIndex(vm => vm.title.toLowerCase() == title.toLowerCase().trim());
		if (index < 0) throw new Error(`No VM called ${title}, the VMs are ${vms.map(vm => vm.title).join(', ')}`);
		return index;
	};

	try {
		for (const [index, url] of urls.entries()) {
			status('Connecting to ' + (vms[index]?.title ?? `VM ${index + 1}`));
			screens.push(await Screen.connect(url));
		}

		const tools = [
			tool(
				'use_vm',
				'Switch to a VM, which the other tools then act on. The lab starts on the first one.',
				{ vm: z.string().describe('VM title, e.g. ZYWIN01') },
				async ({ vm }) => {
					current = select(vm);
					status('Using ' + vms[current].title);
					return textResult(`Now using ${vms[current].title} (${screen().width}x${screen().height})`);
				}
			),

			tool('screenshot', "The current VM's screen", {}, async () => {
				const image = await screen().capture();
				return {
					content: [
						{ type: 'text' as const, text: `${vms[current].title}, ${screen().width}x${screen().height}` },
						{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' },
					],
				};
			}),

			tool(
				'type_text',
				'Type text on the current VM, as if at its keyboard. A newline presses Enter.',
				{ text: z.string() },
				async ({ text }) => {
					await screen().type(text);
					return textResult('Typed ' + JSON.stringify(text));
				}
			),

			tool(
				'press_keys',
				'Press key combinations on the current VM in order, e.g. "Enter", "ctrl+c", or "ctrl+alt+delete"',
				{ keys: z.string().array().min(1) },
				async ({ keys }) => {
					for (const chord of keys) await screen().press(chord);
					return textResult('Pressed ' + keys.join(', '));
				}
			),

			tool(
				'click',
				"Click on the current VM's screen, at coordinates taken from a screenshot",
				{
					x: z.number().int(),
					y: z.number().int(),
					button: z.enum(['left', 'middle', 'right']).optional().describe('By default left'),
					count: z.number().int().min(1).max(3).optional().describe('By default 1, use 2 to double-click'),
				},
				async ({ x, y, button = 'left', count = 1 }) => {
					await screen().click(x, y, button, count);
					return textResult(`${count > 1 ? count + 'x ' : ''}${button} click at ${x},${y}`);
				}
			),

			tool(
				'move_mouse',
				'Move the pointer on the current VM without clicking, to open a menu or show a tooltip',
				{ x: z.number().int(), y: z.number().int() },
				async ({ x, y }) => {
					await screen().move(x, y);
					return textResult(`Moved to ${x},${y}`);
				}
			),

			tool(
				'scroll',
				'Scroll at a point on the current VM',
				{
					x: z.number().int(),
					y: z.number().int(),
					direction: z.enum(['up', 'down']),
					count: z.number().int().min(1).max(20).optional().describe('Wheel clicks, by default 3'),
				},
				async ({ x, y, direction, count = 3 }) => {
					await screen().scroll(x, y, direction, count);
					return textResult(`Scrolled ${direction} at ${x},${y}`);
				}
			),

			tool(
				'wait',
				'Wait for the VM to catch up, e.g. while an application opens or a command runs',
				{ seconds: z.number().min(1).max(120) },
				async ({ seconds }) => {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, seconds * 1000);
					await promise;
					return textResult(`Waited ${seconds}s`);
				},
				readOnly
			),

			tool(
				'check_completion',
				"Run the lab's checks on the VMs and record the points that pass, the same as the Check completion button. Goals that already passed are left alone.",
				{ goals: z.number().int().array().optional().describe('Goal numbers to check, by default every unfinished one') },
				async ({ goals: wanted }) => {
					const already = earned(goals, await zybooks.labCompletion(zybook_code, resource.id));
					const todo = goals.filter(
						(goal, i) => already[i] < goal.points && (wanted === undefined || wanted.includes(goal.index))
					);
					if (!todo.length) return textResult('Every goal asked for is already complete');

					const lines: string[] = [];
					for (const goal of todo) {
						status('Checking goal ' + goal.index);
						if (!(await zybooks.gradingReady(zybook_id, resource.id, goal.instance))) {
							lines.push(`Goal ${goal.index}: ${vms[goal.instance]?.title} is not ready to be checked yet`);
							continue;
						}
						const passed = await zybooks.gradeGoal(zybook_id, resource.id, goal);
						lines.push(`Goal ${goal.index}: ${passed ? `passed, ${goal.points} points` : 'still incomplete'}`);
					}

					const total = earned(goals, await zybooks.labCompletion(zybook_code, resource.id)).reduce((sum, p) => sum + p, 0);
					return textResult(lines.join('\n') + `\n\n${total}/${possible} points`);
				}
			),
		];

		const text = options.resume
			? (options.instructions ?? '')
			: prompt('zybooks-lab', {
					name: lab.name,
					vms: vms.map(vm => `- ${vm.title} (${vm.name})`).join('\n'),
					goals: goals
						.filter((goal, i) => before[i] < goal.points)
						.map(goal => goalText(goal, vms))
						.join('\n'),
					lab: [typeof resource.instructions == 'string' && plain(resource.instructions), labText(resource)]
						.filter(x => x)
						.join('\n\n'),
					dir,
					instructions: options.instructions ? "The student's instructions:\n" + options.instructions : '',
				});

		const result = await runAgent(text, {
			...options,
			dir,
			mcpServers: { lab: createSdkMcpServer({ name: 'lab', version: $pkg.version, tools }) },
			allowedTools: tools.map(t => 'mcp__lab__' + t.name),
		});

		const after = earned(goals, await zybooks.labCompletion(zybook_code, resource.id));
		return { ...result, points: after.reduce((sum, p) => sum + p, 0), possible, recorded: true };
	} finally {
		for (const screen of screens) screen.close();
		status('Deleting the lab VMs');
		await zybooks.deleteLab(zybook_code, resource.id).catch(() => status('Could not delete the lab VMs, delete them in zyBooks'));
	}
}

/** What a test case checks, as the student sees it */
function testText(test: zybooks.TestCase, index: number): string {
	const lines = [`### Test ${index + 1} (${test.points} point${test.points == 1 ? '' : 's'})`];
	if (test.hidden) {
		lines.push('Hidden: neither its input nor its expected output is shown.');
		return lines.join('\n');
	}
	if (test.argStr) lines.push('Arguments: ' + test.argStr);
	if (test.stdin) lines.push('Input:', '```', test.stdin, '```');
	lines.push(
		`Expected output (${test.stdoutCompareMethod == 'starts_with' ? 'output must start with this' : 'must match exactly'}):`,
		'```',
		test.stdout,
		'```'
	);
	return lines.join('\n');
}

/**
 * Have Claude write a programming lab and check it against the lab's own test cases.
 * The lab's files come from the student's zyStudio workspace, and the finished code is written back and submitted there.
 */
export async function codeLab(lab: zybooks.Lab, options: LabOptions): Promise<LabResult> {
	const { zybook_code, zybook_id, resource } = lab;
	const status = (text: string) => options.onStatus?.(text);

	const tests = zybooks.labTests(resource);
	const possible = tests.reduce((sum, test) => sum + test.points, 0);
	if (!tests.length) throw new Error(lab.name + ' has no test cases');

	const submissions = await zybooks.labSubmissions(zybook_id, resource.id).catch(() => []);
	const best = submissions.reduce((top, s) => Math.max(top, s.score), 0);

	status('Opening the zyStudio workspace for ' + lab.name);
	const workspace = await studio.open(lab);
	const starting = await studio.files(workspace);

	const file = starting.find(f => f.isDefault)?.name ?? tests.find(test => test.sourceFile)?.sourceFile ?? 'main.c';
	const language = languageOf(file);
	if (!language) throw new Error(`${lab.name} is written in ${file}, which eedu cannot build or run`);

	const dir = join(labDir, `${zybook_code}-${resource.id}`);
	mkdirSync(dir, { recursive: true });
	for (const { name, content } of starting) if (!name.includes('/')) writeFileSync(join(dir, name), content);

	let points = 0;
	let submitted = false;

	const tools = [
		tool(
			'run_tests',
			"Build the lab's code and run it against the lab's own test cases on this machine, reporting what passed. Only files in the lab directory are built and run. This does not submit anything.",
			{
				file: z.string().optional().describe(`Source file in the lab directory, by default ${file}`),
				tests: z.number().int().min(1).array().optional().describe('Test numbers to run, by default all of them'),
			},
			async ({ file: source = file, tests: wanted }) => {
				const chosen = wanted ? wanted.map(n => tests[n - 1]).filter(test => test) : tests;
				status(`Running ${chosen.length} test(s) against ${source}`);

				const results = await runTests(dir, source, chosen);

				const lines = results.map(result => {
					const number = tests.indexOf(result.test) + 1;
					if (result.passed) return `Test ${number}: passed, ${result.test.points} point(s)`;
					const detail = result.error ?? firstDifference(result.output, result.test.stdout) ?? 'output did not match';
					return `Test ${number}: failed, ${detail}\n  got: ${JSON.stringify(result.output)}`;
				});

				const total = results.reduce((sum, result) => sum + result.points, 0);
				return textResult(lines.join('\n') + `\n\n${total}/${chosen.reduce((s, t) => s + t.points, 0)} points on these tests`);
			}
		),

		tool(
			'submit_lab',
			"Upload the lab's files to zyStudio, run its tests there, and record the result as the student's submission. The student approves each submission.",
			{ files: z.string().array().min(1).optional().describe(`Files in the lab directory to upload, by default ${file}`) },
			async ({ files: wanted = [file] }) => {
				for (const name of wanted) {
					const path = join(dir, name);
					if (!within(path, [dir])) return textResult(`${name} is outside the lab directory`, true);
					if (!existsSync(path)) return textResult(`${name} does not exist`, true);
					status('Uploading ' + name);
					await studio.writeFile(workspace, name, readFileSync(path, 'utf8'));
				}

				status('Running the tests in zyStudio, which takes a moment');
				const result = await studio.score(workspace);
				await studio.recordSubmission(zybook_code, resource.id);
				submitted = true;
				points = Math.max(points, result.points);
				status(`Submitted ${lab.name}, ${result.points}/${result.possible} points`);

				const lines = result.results.map((test, i) => {
					if (test.passed) return `Test ${i + 1}: passed`;
					const detail = test.error || firstDifference(test.actual ?? '', test.expected ?? '') || 'output did not match';
					return `Test ${i + 1}: failed, ${detail}`;
				});
				return textResult([`Submitted. ${result.points}/${result.possible} points recorded.`, ...lines].join('\n'));
			}
		),
	];

	const text = options.resume
		? (options.instructions ?? '')
		: prompt('zybooks-code-lab', {
				name: lab.name,
				language,
				file,
				dir,
				files: starting.map(f => `- ${f.name}${f.isDefault ? ' (the file to edit)' : ''}`).join('\n'),
				tests: tests.map(testText).join('\n\n'),
				lab: htmlToText(typeof resource.instructions == 'string' ? resource.instructions : ''),
				history: submissions.length ? `Submitted ${submissions.length} time(s), best score ${best}/${possible}.` : 'Not submitted yet.',
				instructions: options.instructions ? "The student's instructions:\n" + options.instructions : '',
			});

	const result = await runAgent(text, {
		...options,
		dir,
		mcpServers: { lab: createSdkMcpServer({ name: 'lab', version: $pkg.version, tools }) },
		allowedTools: ['mcp__lab__run_tests'],
		askTools: ['mcp__lab__submit_lab'],
	});

	return { ...result, points: submitted ? points : best, possible, recorded: submitted, dir };
}
