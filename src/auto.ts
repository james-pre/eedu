import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Manager } from '@james-pre/config';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod';
import $pkg from '../package.json' with { type: 'json' };
import { getAssignment, type Assignment, type AssignmentSource } from './assignments.js';
import { dataDir } from './data.js';
import { pluginDir, prompt, runAgent, type AgentOptions, type AgentResult } from './llm.js';
import * as canvas from './platforms/canvas.js';
import type * as canvasTypes from './platforms/canvas.types.js';
import { htmlToText } from './text.js';

export const AutoData = z.object({
	/** Where schoolwork exists, e.g.`<dir>/<course>/<assignment>.md` */
	dir: z.string().default(join(homedir(), 'Documents/school')),
});

export interface AutoData extends z.infer<typeof AutoData> {}

export const store = new Manager(AutoData);
store.loadFile(join(dataDir, 'auto.json'), { create: true });

export const data = store.data;

/** Text safe to use as a file name */
export function slug(text: string): string {
	return text.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function assignmentPath(assignment: Assignment): string {
	return join(data.dir, slug(assignment.course.id), slug(assignment.name) + '.md');
}

function assignmentText(a: Assignment): string {
	const lines = [
		'ID: ' + a.id,
		'Name: ' + a.name,
		'Course: ' + a.course.name,
		a.category && 'Category: ' + a.category,
		a.due && 'Due: ' + a.due.toLocaleString(),
		a.lock && 'Closes: ' + a.lock.toLocaleString(),
		'Points: ' + a.possible,
		'Status: ' + [a.status, a.late && 'late', a.missing && 'missing', a.locked && 'locked'].filter(x => x).join(', '),
		'Submission types: ' + a.types.join(', '),
		a.extensions && 'Allowed file types: ' + a.extensions.join(', '),
		a.url && 'URL: ' + a.url,
		'',
		a.description ? htmlToText(a.description) : 'No description.',
	];
	return lines.filter(line => line !== undefined).join('\n');
}

function discussionText(topic: canvasTypes.DiscussionTopic, view?: canvasTypes.DiscussionView): string {
	const lines = [`# ${topic.title}`, `Topic ID: ${topic.id}`, '', htmlToText(topic.message)];
	if (!view) return lines.join('\n');

	const names = new Map(view.participants.map(p => [p.id, p.display_name]));
	const addEntry = (entry: canvasTypes.DiscussionViewEntry, depth: number) => {
		const indent = '  '.repeat(depth);
		if (entry.deleted) lines.push(indent + '- (deleted)');
		else {
			lines.push(
				`${indent}- ${names.get(entry.user_id) ?? 'Unknown'} (entry #${entry.id}, ${new Date(entry.created_at).toLocaleString()}):`
			);
			for (const line of htmlToText(entry.message ?? '').split('\n')) lines.push(indent + '  ' + line);
		}
		for (const reply of entry.replies ?? []) addEntry(reply, depth + 1);
	};

	lines.push('', '## Entries', '');
	for (const entry of view.view) addEntry(entry, 0);
	if (!view.view.length) lines.push('No entries yet.');
	return lines.join('\n');
}

const textResult = (text: string, isError: boolean = false) => ({ content: [{ type: 'text' as const, text }], isError });

/** An in-process MCP server with read-only tools for courses and assignments */
export function eeduServer(sources: AssignmentSource[]) {
	const getAssignmentTool = tool(
		'get_assignment',
		'Get an assignment: its description, due date, points, status, and how it is submitted',
		{ id: z.string().describe('Assignment ID, e.g. canvas:12345') },
		async ({ id }) => textResult(assignmentText(await getAssignment(sources, id))),
		{ annotations: { readOnlyHint: true } }
	);

	const readDiscussionTool = tool(
		'read_discussion',
		"Read a discussion assignment's prompt and the entries and replies posted so far",
		{ assignment: z.string().describe('ID of the discussion assignment, e.g. canvas:12345') },
		async ({ assignment: id }) => {
			const assignment = await getAssignment(sources, id);
			if (!id.startsWith('canvas:')) return textResult('Discussions are only supported for Canvas', true);

			const topic = await canvas.assignmentDiscussion(assignment.course, Number(id.slice('canvas:'.length)));
			if (!topic) return textResult(assignment.name + ' is not a discussion', true);

			try {
				return textResult(discussionText(topic, await canvas.viewDiscussion(assignment.course, topic.id)));
			} catch (e) {
				if (!(e instanceof canvas.RequestError) || e.status != 403) throw e;
				return textResult(discussionText(topic) + '\n\n' + e.message);
			}
		},
		{ annotations: { readOnlyHint: true } }
	);

	return createSdkMcpServer({ name: 'eedu', version: $pkg.version, tools: [getAssignmentTool, readDiscussionTool] });
}

export interface AssignmentOptions extends Omit<AgentOptions, 'dir' | 'readable' | 'mcpServers' | 'allowedTools'> {
	/** Extra instructions from the student, or their feedback when continuing a session */
	instructions?: string;
}

export interface AssignmentResult extends AgentResult {
	path: string;
}

/**
 * Have Claude work on an assignment in {@link assignmentPath}, revising the file if it already exists.
 * Claude can only write in the course's directory and can't submit anything.
 */
export async function assignment(sources: AssignmentSource[], a: Assignment, options: AssignmentOptions): Promise<AssignmentResult> {
	const path = assignmentPath(a);
	mkdirSync(dirname(path), { recursive: true });

	const text = options.resume
		? (options.instructions ?? '')
		: prompt('assignment', {
				assignment: a.id,
				path,
				existing: existsSync(path) ? 'The file already exists, so revise it.' : '',
				instructions: options.instructions ? "The student's instructions:\n" + options.instructions : '',
			});

	const result = await runAgent(text, {
		...options,
		dir: dirname(path),
		readable: [pluginDir],
		mcpServers: { eedu: eeduServer(sources) },
		allowedTools: ['mcp__eedu__*'],
	});

	return { ...result, path };
}
