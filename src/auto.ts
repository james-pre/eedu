import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Manager } from '@james-pre/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as z from 'zod';
import $pkg from '../package.json' with { type: 'json' };
import {
	attachments,
	checkSubmission,
	courseAssignments,
	getAssignment,
	submit,
	type Assignment,
	type AssignmentSource,
	type Attachment,
	type Submission,
} from './assignments.js';
import { dataDir, school, type Course } from './data.js';
import * as documents from './documents.js';
import { courseGrades } from './grades.js';
import { pluginDir, prompt, runAgent, within, type AgentOptions, type AgentResult } from './llm.js';
import * as canvas from './platforms/canvas/index.js';
import { parseAnswer, quizText, timeLeft, unanswered } from './platforms/canvas/answers.js';
import * as quizzes from './platforms/canvas/quizzes.js';
import type * as canvasTypes from './platforms/canvas/types.js';
import { htmlToText, readText, toHTML } from './text.js';

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

export function courseDir(course: Course): string {
	return join(data.dir, slug(course.id));
}

/** Notes about a course and its assignments, kept up to date by Claude */
export function courseNotes(course: Course): string {
	return join(courseDir(course), 'course.md');
}

/** Facts about the student that apply across courses */
export function studentProfile(): string {
	return join(data.dir, 'student.md');
}

const statusText = (a: Assignment) => [a.status, a.late && 'late', a.missing && 'missing', a.locked && 'locked'].filter(x => x).join(', ');

function assignmentText(a: Assignment): string {
	const lines = [
		'ID: ' + a.id,
		'Name: ' + a.name,
		'Course: ' + a.course.name,
		a.category && 'Category: ' + a.category,
		a.due && 'Due: ' + a.due.toLocaleString(),
		a.lock && 'Closes: ' + a.lock.toLocaleString(),
		'Points: ' + (a.score === null ? '' : a.score + '/') + a.possible,
		'Status: ' + statusText(a),
		'Submission types: ' + a.types.join(', '),
		a.extensions && 'Allowed file types: ' + a.extensions.join(', '),
		a.url && 'URL: ' + a.url,
		'',
		a.description ? htmlToText(a.description) : 'No description.',
	];
	return lines.filter(line => line !== undefined).join('\n');
}

async function courseText(sources: AssignmentSource[], course: Course): Promise<string> {
	const term = school.data.terms.find(t => t.id == course.term);
	const dir = courseDir(course);
	const lines = [
		`# ${course.name}`,
		'ID: ' + course.id,
		'Term: ' + (term ? `${term.name} (${term.start.toLocaleDateString()} to ${term.end.toLocaleDateString()})` : course.term),
		'Directory: ' + dir,
	];

	const categories = Object.entries(courseGrades(course.id).categories);
	if (categories.length) {
		lines.push('', '## Grade categories', '');
		for (const [name, c] of categories)
			lines.push(
				`- ${name}: ${c.weight === undefined ? 'weight unknown' : (c.weight * 100).toFixed(1) + '%'}`
					+ (c.dropped ? `, ${c.dropped} dropped` : '')
			);
	}

	lines.push('', '## Assignments', '');
	for (const a of await courseAssignments(sources, course)) {
		const due = a.due ? 'due ' + a.due.toLocaleString() : 'no due date';
		const points = (a.score === null ? '' : a.score + '/') + a.possible + ' points';
		lines.push(`- ${a.id} ${a.name} (${a.category ?? 'uncategorized'}): ${due}, ${points}, ${statusText(a)}`);
	}

	if (existsSync(dir)) {
		lines.push('', '## Files', '');
		for (const name of readdirSync(dir).filter(name => !name.startsWith('.'))) lines.push('- ' + name);
	}

	return lines.join('\n');
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

const readOnly = { annotations: { readOnlyHint: true } };

/**
 * MCP tools for reading and writing a course's assignments, discussions, and documents.
 * Paths are relative to the course directory, and can be read anywhere in the school directory but only written in the course directory.
 */
export interface ToolEvents {
	/** What a tool is doing, in words */
	onStatus?(text: string): void;
	/** A submission or discussion post was made */
	onSubmit?(): void;
}

/** Why a submit_assignment or post_discussion call can't go ahead because its files still have placeholders like `[TODO: ...]` */
export async function unfinished(course: Course, tool: string, input: Record<string, any>): Promise<string | undefined> {
	const files: unknown[] =
		tool == 'submit_assignment' ? [input.text_file, ...(input.files ?? [])] : tool == 'post_discussion' ? [input.file] : [];
	const dir = courseDir(course);

	const found: string[] = [];
	for (const file of files) {
		if (typeof file != 'string') continue;
		const full = resolve(dir, file);
		if (!within(full, [dir]) || !existsSync(full)) continue;
		for (const placeholder of await documents.placeholders(full)) found.push(`${file}: ${placeholder}`);
	}

	if (!found.length) return;
	return "These files still have placeholders, so they can't be submitted until they're filled in:\n" + found.join('\n');
}

/** The discussion topic of an assignment or a topic ID, as given to post_discussion */
async function discussionOf(course: Course, assignment?: string, topic?: number): Promise<canvasTypes.DiscussionTopic | undefined> {
	if (assignment) {
		if (!assignment.startsWith('canvas:')) throw new Error('Discussions are only supported for Canvas');
		return canvas.assignmentDiscussion(course, Number(assignment.slice('canvas:'.length)));
	}
	if (topic !== undefined) return canvas.getDiscussion(course, topic);
}

/** What a submit_assignment call submits, in words */
const submissionText = ({ text_file, files, url }: { text_file?: string; files?: string[]; url?: string }) =>
	text_file ?? files?.join(', ') ?? url ?? 'nothing';

/** A question asking the student to approve a call to one of the tools that act on their behalf */
export async function describeRequest(
	sources: AssignmentSource[],
	course: Course,
	tool: string,
	input: Record<string, any>
): Promise<string | undefined> {
	switch (tool) {
		case 'mcp__eedu__submit_assignment': {
			const a = await getAssignment(sources, input.assignment, course);
			return `Submit ${submissionText(input)} for ${a.name}?` + (input.comment ? ` (comment: "${input.comment}")` : '');
		}
		case 'mcp__eedu__post_discussion': {
			const title = (await discussionOf(course, input.assignment, input.topic))?.title ?? 'the discussion';
			return input.reply_to === undefined
				? `Post ${input.file} to ${title}?`
				: `Post ${input.file} as a reply to entry #${input.reply_to} in ${title}?`;
		}
		case 'mcp__eedu__submit_quiz': {
			const a = await getAssignment(sources, input.assignment, course);
			return `Turn in ${a.name}?` + (input.allow_unanswered ? ' Some questions are unanswered.' : '');
		}
	}
}

/** The quiz behind a quiz assignment, as `canvas:<id>` */
function quizAssignment(assignment: Assignment): string {
	if (!assignment.types.includes('quiz') || !assignment.id.startsWith('canvas:'))
		throw new Error(assignment.name + ' is not a New Quizzes quiz');
	return assignment.id.slice('canvas:'.length);
}

export interface ToolOptions extends quizzes.OpenOptions {
	/** Show Claude the instructions of quizzes it opens */
	quizInstructions?: boolean;
}

export function eeduTools(sources: AssignmentSource[], course: Course, events: ToolEvents = {}, options: ToolOptions = {}) {
	const dir = courseDir(course);
	const status = (text: string) => events.onStatus?.(text);
	const openQuizzes = new Map<string, quizzes.OpenQuiz>();

	const openQuiz = async (assignment: Assignment): Promise<quizzes.OpenQuiz> => {
		const opened = openQuizzes.get(assignment.id);
		if (opened) return opened;
		const quiz = await quizzes.open(course, quizAssignment(assignment), options);
		openQuizzes.set(assignment.id, quiz);
		const remaining = timeLeft(quiz);
		status(`Opened ${assignment.name}` + (remaining ? `, a timed quiz with ${remaining}` : ''));
		return quiz;
	};

	const quizError = (e: unknown) => {
		if (e instanceof quizzes.QuizError) return textResult(e.message, true);
		throw e;
	};

	const path = (path: string, access: 'read' | 'write'): string => {
		const full = resolve(dir, path);
		const allowed = access == 'write' ? [dir, studentProfile()] : [data.dir, pluginDir];
		if (!within(full, allowed)) throw new Error(`${path} is outside of ${access == 'write' ? dir : data.dir}`);
		return full;
	};

	/** Save files that aren't already in `target` */
	const saveFiles = async (files: Attachment[], target: string): Promise<string[]> => {
		mkdirSync(target, { recursive: true });
		const lines = [];
		for (const file of files) {
			const out = join(target, slug(file.name));
			if (existsSync(out)) lines.push('Already have ' + relative(dir, out));
			else {
				writeFileSync(out, await file.download());
				lines.push('Saved ' + relative(dir, out));
				status('Downloaded ' + relative(dir, out));
			}
		}
		return lines;
	};

	return [
		tool(
			'get_course',
			"Get the course: its term, grade categories, every assignment with due dates and scores, and the files in the course's directory",
			{},
			async () => {
				status('Reading course ' + course.name);
				return textResult(await courseText(sources, course));
			},
			readOnly
		),

		tool(
			'get_assignment',
			'Get an assignment: its description, due date, points, status, and how it is submitted',
			{ id: z.string().describe('Assignment ID, e.g. canvas:12345') },
			async ({ id }) => {
				const a = await getAssignment(sources, id, course);
				status('Reading assignment ' + a.name);
				return textResult(assignmentText(a));
			},
			readOnly
		),

		tool(
			'read_discussion',
			"Read a discussion assignment's prompt and the entries and replies posted so far",
			{ assignment: z.string().describe('ID of the discussion assignment, e.g. canvas:12345') },
			async ({ assignment: id }) => {
				const assignment = await getAssignment(sources, id, course);
				if (!id.startsWith('canvas:')) return textResult('Discussions are only supported for Canvas', true);

				const topic = await canvas.assignmentDiscussion(course, Number(id.slice('canvas:'.length)));
				if (!topic) return textResult(assignment.name + ' is not a discussion', true);
				status('Reading discussion ' + topic.title);

				try {
					return textResult(discussionText(topic, await canvas.viewDiscussion(course, topic.id)));
				} catch (e) {
					if (!(e instanceof canvas.RequestError) || e.status != 403) throw e;
					return textResult(discussionText(topic) + '\n\n' + e.message);
				}
			},
			readOnly
		),

		tool(
			'download_attachments',
			"Download the files linked from an assignment's description, such as the questions, templates, and rubrics. Files that already exist are kept.",
			{
				assignment: z.string().describe('Assignment ID, e.g. canvas:12345'),
				folder: z.string().optional().describe('Folder in the course directory to save into, by default the course directory'),
			},
			async ({ assignment: id, folder = '.' }) => {
				const a = await getAssignment(sources, id, course);
				status('Downloading files for ' + a.name);
				const lines = await saveFiles(await attachments(sources, a), path(folder, 'write'));
				return textResult(lines.join('\n') || 'The assignment has no linked files');
			}
		),

		tool(
			'read_syllabus',
			"Read the course's syllabus, description, and home page, and pages titled like a syllabus, and download syllabus files and the files they link into the syllabus folder of the course directory. Files that already exist are kept.",
			{},
			async () => {
				if (course.canvas_id === undefined) return textResult('Syllabi can only be read from Canvas', true);
				status('Reading the syllabus of ' + course.name);
				const { pages, files } = await canvas.syllabus(course);
				const lines = await saveFiles(files, path('syllabus', 'write'));
				const text = pages.map(page => `# ${page.title}\n\n${htmlToText(page.html).trim()}`);
				if (lines.length) text.push('# Files\n\n' + lines.join('\n'));
				return textResult(text.join('\n\n') || 'No syllabus found in Canvas');
			}
		),

		tool(
			'read_document',
			'Read the text of a document: Markdown for .docx/.odt/.rtf/.html, CSV for each sheet of .xlsx/.ods, and text for .pdf/.pptx and plain text files',
			{ path: z.string() },
			async ({ path: p }) => {
				status('Reading ' + p);
				return textResult(await documents.readDocument(path(p, 'read')));
			},
			readOnly
		),

		tool(
			'render_document',
			'Render pages of a document (.pdf, .md, .docx, .pptx, .xlsx, ...) as images to check how it looks. Markdown is built to PDF with pandoc first.',
			{
				path: z.string(),
				first: z.number().int().min(1).optional().describe('First page, by default 1'),
				count: z.number().int().min(1).max(10).optional().describe('Number of pages, by default 5'),
			},
			async ({ path: p, first = 1, count = 5 }) => {
				const full = path(p, p.endsWith('.md') ? 'write' : 'read');
				status('Rendering ' + p);
				const { pages, total } = await documents.renderDocument(full, first, count);
				return {
					content: [
						{ type: 'text' as const, text: `Pages ${first} to ${first + pages.length - 1} of ${total}` },
						...pages.map(page => ({ type: 'image' as const, data: page.toString('base64'), mimeType: 'image/png' })),
					],
				};
			},
			readOnly
		),

		tool(
			'build_pdf',
			"Build a PDF next to a Markdown file with pandoc, using the student's settings (xelatex, $ math, raw TeX)",
			{ path: z.string().describe('Markdown file') },
			async ({ path: p }) => {
				const pdf = relative(dir, await documents.buildPdf(path(p, 'write')));
				status('Built ' + pdf);
				return textResult('Built ' + pdf);
			}
		),

		tool(
			'convert_document',
			"Convert a document to the format of the output's extension, e.g. .md to .docx/.pptx/.pdf, .csv to .xlsx, or .docx to .pdf",
			{ input: z.string(), output: z.string() },
			async ({ input, output }) => {
				status(`Converting ${input} to ${output}`);
				await documents.convertDocument(path(input, 'read'), path(output, 'write'));
				return textResult('Wrote ' + output);
			}
		),

		tool(
			'unpack_office',
			'Extract a .docx/.pptx/.xlsx file into a folder so its XML can be edited with Read and Edit. Replaces any earlier extraction of the same file.',
			{ path: z.string() },
			async ({ path: p }) => {
				status('Unpacking ' + p);
				const { dir: parts, parts: names } = await documents.unpackOffice(path(p, 'write'));
				return textResult(`Extracted to ${relative(dir, parts)}:\n` + names.map(name => '- ' + name).join('\n'));
			}
		),

		tool(
			'pack_office',
			'Zip a folder from unpack_office back into an office file. The first time an existing file is replaced, the original is kept as .<name>.orig<ext>.',
			{ folder: z.string(), output: z.string() },
			async ({ folder, output }) => {
				status('Packing ' + output);
				await documents.packOffice(path(folder, 'write'), path(output, 'write'));
				return textResult('Wrote ' + output);
			}
		),

		tool(
			'submit_assignment',
			'Submit to an assignment that is not a discussion; use post_discussion for those. Give exactly one of text_file (.md is converted), files (one or more to upload together), or url. The student approves each submission.',
			{
				assignment: z.string().describe('Assignment ID, e.g. canvas:12345'),
				text_file: z.string().optional().describe('File whose text is submitted'),
				files: z.string().array().min(1).optional().describe('Files to upload, all in one submission'),
				url: z.string().optional(),
				comment: z.string().optional().describe('Comment on the submission'),
			},
			async input => {
				const { assignment: id, text_file, files, url, comment } = input;
				const placeholders = await unfinished(course, 'submit_assignment', input);
				if (placeholders) return textResult(placeholders, true);
				if ([text_file, files, url].filter(x => x !== undefined).length != 1)
					return textResult('Give exactly one of text_file, files, or url', true);

				const submission: Submission = text_file
					? { type: 'text', text: readText(path(text_file, 'write')) }
					: files
						? { type: 'file', paths: files.map(file => path(file, 'write')) }
						: { type: 'url', url: url! };

				const a = await getAssignment(sources, id, course);
				if (a.types.includes('discussion'))
					return textResult(`${a.name} is a discussion; post to its board with post_discussion instead`, true);
				checkSubmission(a, submission);
				await submit(sources, a, submission, { comment });
				events.onSubmit?.();
				status(`Submitted ${submissionText(input)} for ${a.name}`);
				return textResult('Submitted to ' + a.name);
			}
		),

		tool(
			'post_discussion',
			"Post a file's text to a discussion, as a new entry or a reply to an entry; .md is converted. The student approves each post.",
			{
				assignment: z.string().optional().describe('ID of the discussion assignment, e.g. canvas:12345'),
				topic: z.number().int().optional().describe('Discussion topic ID, for discussions that are not assignments'),
				file: z.string(),
				reply_to: z.number().int().optional().describe('ID of the entry to reply to'),
			},
			async ({ assignment: id, topic: topicId, file, reply_to }) => {
				const placeholders = await unfinished(course, 'post_discussion', { file });
				if (placeholders) return textResult(placeholders, true);
				const topic = await discussionOf(course, id, topicId);
				if (!topic) return textResult('Give the assignment of a discussion, or a topic', true);

				const message = toHTML(readText(path(file, 'write')));
				const entry =
					reply_to === undefined
						? await canvas.postEntry(course, topic.id, message)
						: await canvas.replyToEntry(course, topic.id, reply_to, message);
				events.onSubmit?.();
				status(reply_to === undefined ? `Posted ${file} to ${topic.title}` : `Replied to entry #${reply_to} in ${topic.title}`);
				return textResult(`Posted entry #${entry.id}`);
			}
		),

		tool(
			'open_quiz',
			"Open a quiz assignment, starting the student's attempt or resuming it, and get its questions with the IDs answers use and any answers already saved.",
			{ assignment: z.string().describe('Assignment ID, e.g. canvas:12345') },
			async ({ assignment: id }) => {
				const a = await getAssignment(sources, id, course);
				try {
					return textResult(quizText(await openQuiz(a), { instructions: options.quizInstructions }));
				} catch (e) {
					return quizError(e);
				}
			}
		),

		tool(
			'answer_question',
			'Save the answer to one quiz question, replacing any earlier answer, in the format open_quiz gives. Answers are saved to the attempt but not turned in.',
			{
				assignment: z.string().describe('Assignment ID, e.g. canvas:12345'),
				position: z.number().int().describe('Question position'),
				answer: z.string().describe('Markdown for essays, JSON for everything else'),
			},
			async ({ assignment: id, position, answer }) => {
				const placeholders = documents.textPlaceholders(answer);
				if (placeholders.length)
					return textResult("The answer still has placeholders, so it can't be saved:\n" + placeholders.join('\n'), true);

				const a = await getAssignment(sources, id, course);
				try {
					const quiz = await openQuiz(a);
					const item = quiz.items.find(item => item.position == position);
					if (!item) return textResult(`${a.name} has no question ${position}`, true);

					let value;
					try {
						value = parseAnswer(item, answer);
					} catch (e) {
						return textResult(`Question ${position}: ` + (e instanceof Error ? e.message : String(e)), true);
					}

					const next = await quizzes.save(quiz, { position, value });
					status(`Saved the answer to question ${position} of ${a.name}`);

					const left = unanswered(quiz);
					const remaining = timeLeft(quiz);
					const lines = [
						`Saved question ${position}.`,
						left.length ? 'Unanswered: ' + left.join(', ') : 'Every question is answered.',
						remaining && `Time: ${remaining}`,
					];
					if (next)
						lines.push(
							'',
							'Next question:',
							'',
							quizText({ ...quiz, items: [next] }, { instructions: false })
								.split('\n## ')
								.slice(1)
								.map(text => '## ' + text)
								.join('\n')
						);
					else if (next === null) lines.push('That was the last question.');
					return textResult(lines.filter(line => typeof line == 'string').join('\n'));
				} catch (e) {
					return quizError(e);
				}
			}
		),

		tool(
			'submit_quiz',
			'Turn in a quiz with its saved answers. This ends the attempt. The student approves each submission.',
			{
				assignment: z.string().describe('Assignment ID, e.g. canvas:12345'),
				allow_unanswered: z.boolean().optional().describe('Turn it in even though some questions have no answer'),
			},
			async ({ assignment: id, allow_unanswered }) => {
				const a = await getAssignment(sources, id, course);
				try {
					const quiz = await openQuiz(a);
					const left = unanswered(quiz);
					if (left.length && !allow_unanswered)
						return textResult(
							`These questions have no answer yet: ${left.join(', ')}. Answer them, or set allow_unanswered.`,
							true
						);

					await quizzes.submit(quiz);
					openQuizzes.delete(a.id);
					events.onSubmit?.();
					status('Turned in ' + a.name);
					return textResult(`Turned in ${a.name} with ${quiz.responses.size} answers`);
				} catch (e) {
					return quizError(e);
				}
			}
		),
	];
}

/** Tools that act on the student's behalf, which always need their approval */
const askTools = ['submit_assignment', 'post_discussion', 'submit_quiz'];

export interface AssignmentOptions
	extends Omit<AgentOptions, 'dir' | 'readable' | 'writable' | 'mcpServers' | 'allowedTools' | 'askTools'>, ToolOptions {
	/** Extra instructions from the student, or their feedback when continuing a session */
	instructions?: string;
	onStatus?: ToolEvents['onStatus'];
}

export interface AssignmentResult extends AgentResult {
	/** The course directory, where Claude wrote its files */
	dir: string;
	/** Whether Claude submitted or posted anything */
	submitted: boolean;
}

/**
 * Have Claude work on an assignment in its course's directory, using and updating the course notes and student profile.
 * Claude can only write in the course's directory and to the student profile, and the student approves each submission and post.
 */
export async function assignment(sources: AssignmentSource[], a: Assignment, options: AssignmentOptions): Promise<AssignmentResult> {
	const dir = courseDir(a.course);
	mkdirSync(dir, { recursive: true });
	let submitted = false;
	const tools = eeduTools(
		sources,
		a.course,
		{ onStatus: options.onStatus, onSubmit: () => (submitted = true) },
		{ quizInstructions: options.quizInstructions, accessCode: options.accessCode }
	);

	const text = options.resume
		? (options.instructions ?? '')
		: prompt('assignment', {
				assignment: a.id,
				dir,
				notes: courseNotes(a.course),
				profile: studentProfile(),
				instructions: options.instructions ? "The student's instructions:\n" + options.instructions : '',
			});

	const result = await runAgent(text, {
		...options,
		dir,
		readable: [data.dir, pluginDir],
		writable: [studentProfile()],
		mcpServers: { eedu: createSdkMcpServer({ name: 'eedu', version: $pkg.version, tools }) },
		allowedTools: tools.filter(t => !askTools.includes(t.name)).map(t => 'mcp__eedu__' + t.name),
		askTools: askTools.map(name => 'mcp__eedu__' + name),
		validate: (tool, input) => unfinished(a.course, tool.replace(/^mcp__eedu__/, ''), input),
	});

	return { ...result, dir, submitted };
}
