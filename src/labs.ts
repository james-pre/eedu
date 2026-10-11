import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import $pkg from '../package.json' with { type: 'json' };
import { dataDir } from './data.js';
import { prompt, runAgent, type AgentOptions, type AgentResult } from './llm.js';
import * as zybooks from './platforms/zybooks.js';
import { Screen } from './vnc.js';

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
}

/**
 * Have Claude work through an IT lab on its VMs.
 * The VMs are started before the agent runs and deleted once it is done, since they are billed for as long as they run.
 */
export async function lab(lab: zybooks.Lab, options: LabOptions): Promise<LabResult> {
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
		return { text: 'Already complete', sessionId: '', cost: 0, points, possible };
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
		return { ...result, points: after.reduce((sum, p) => sum + p, 0), possible };
	} finally {
		for (const screen of screens) screen.close();
		status('Deleting the lab VMs');
		await zybooks.deleteLab(zybook_code, resource.id).catch(() => status('Could not delete the lab VMs, delete them in zyBooks'));
	}
}
