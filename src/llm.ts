import {
	query,
	type HookCallback,
	type HookPermissionDecision,
	type McpServerConfig,
	type Options,
	type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { config } from './config.js';

/** The Claude Code plugin holding eedu's skills */
export const pluginDir = join(import.meta.dirname, '../plugin');

const promptDir = join(import.meta.dirname, '../prompts');

/** Names of the skills in eedu's plugin, as `eedu:<name>` */
export function skills(): string[] {
	return readdirSync(join(pluginDir, 'skills')).map(name => 'eedu:' + name);
}

/** The prompt in `prompts/<name>.md` with each `{{key}}` replaced by its value */
export function prompt(name: string, vars: Record<string, string> = {}): string {
	const template = readFileSync(join(promptDir, name + '.md'), 'utf8');
	return template
		.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
			if (!(key in vars)) throw new Error(`Prompt ${name} needs a value for ${key}`);
			return vars[key];
		})
		.trim();
}

/** Authentication for the SDK, which currently uses its own default credentials */
function auth(): Partial<Options> {
	return {};
}

function baseOptions(model?: string): Options {
	return { ...auth(), model: model ?? config.llm, effort: config.llm_effort, settingSources: [] };
}

function resultText(message: SDKResultMessage): string {
	if (message.subtype == 'success') return message.result;
	throw new Error(message.errors.join('\n') || 'Claude stopped: ' + message.subtype);
}

export interface AskOptions {
	/** Built-in tools Claude can use, e.g. `Read` */
	tools?: string[];
	cwd?: string;
	model?: string;
	/** Milliseconds before giving up */
	timeout?: number;
}

/** Run a prompt to completion without any interaction, returning Claude's final response */
export async function ask(text: string, options: AskOptions = {}): Promise<string> {
	const { tools = [], cwd, timeout } = options;
	const abortController = new AbortController();
	const timer = timeout ? setTimeout(() => abortController.abort(), timeout) : undefined;

	try {
		const messages = query({
			prompt: text,
			options: { ...baseOptions(options.model), cwd, tools, allowedTools: tools, permissionMode: 'dontAsk', abortController },
		});
		for await (const message of messages) if (message.type == 'result') return resultText(message);
	} finally {
		clearTimeout(timer);
	}

	throw new Error('Claude did not respond');
}

/** A question from Claude's `AskUserQuestion` tool */
export interface Question {
	question: string;
	/** A short label for the question */
	header: string;
	options: { label: string; description: string }[];
	multiSelect: boolean;
}

export interface AgentOptions {
	/** The working directory, which the agent can read and write */
	dir: string;
	/** Directories the agent can also read */
	readable?: string[];
	/** Directories and files the agent can also write */
	writable?: string[];
	mcpServers?: Record<string, McpServerConfig>;
	/** Tools that run without approval, by exact name */
	allowedTools?: string[];
	/** Tools that always need approval, in addition to Bash */
	askTools?: string[];
	/** Bash commands that run without approval, where `*` matches one argument's worth of text */
	allowedCommands?: string[];
	/** A Bash command was run without asking, because eedu allows it */
	onAutoApprove?(tool: string, input: Record<string, unknown>): void;
	/** @returns Why a tool call isn't allowed, which denies it before anything else */
	validate?(tool: string, input: Record<string, unknown>): Promise<string | undefined>;
	model?: string;
	/** Session to continue */
	resume?: string;
	/** Use the SDK's `acceptEdits` permission mode */
	acceptEdits?: boolean;
	/** Use files anywhere, run Bash commands, and fetch web pages without approval, except for risky commands */
	yolo?: boolean;
	/** @returns The answer to each question, keyed by question text */
	answer(questions: Question[]): Promise<Record<string, string>>;
	/** Whether to allow a tool call that eedu does not allow on its own, or why the user declined it */
	approve(tool: string, input: Record<string, unknown>): Promise<boolean | { reason: string }>;
	onText?(text: string): void;
	onTool?(name: string, input: Record<string, unknown>): void;
}

export interface AgentResult {
	text: string;
	sessionId: string;
	/** Estimated cost in USD */
	cost: number;
}

const agentTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'AskUserQuestion', 'Skill', 'WebSearch', 'WebFetch'];

const fileAccess: Record<string, 'read' | 'write'> = { Read: 'read', Glob: 'read', Grep: 'read', Write: 'write', Edit: 'write' };

/** Whether `path` is one of `dirs` or inside one */
export function within(path: string, dirs: string[]): boolean {
	return dirs.some(dir => {
		const rel = relative(resolve(dir), path);
		return rel != '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
	});
}

/** Characters that let a shell do more than run one command with plain arguments */
const shellSyntax = /[;&|<>`$()\\\n'"*?{}[\]~!#]/;

/** Whether a single command is exactly one of `patterns`, with nothing a shell would treat specially and no `..` in its paths */
function allowedSingle(command: string, patterns: string[]): boolean {
	const text = command.replace(/\s+2>\/dev\/null$/, '').trim();
	if (!text || shellSyntax.test(text)) return false;
	if (text.split(/\s+/).some(argument => argument.split('/').includes('..'))) return false;
	return patterns.some(pattern => {
		const escaped = pattern.split('*').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
		return new RegExp('^' + escaped.join('[^\\s]*') + '$').test(text);
	});
}

/**
 * Whether every command in a Bash command line is one of `patterns`.
 * Commands can be joined with `;` or `&&`, and each can discard its errors with `2>/dev/null`.
 */
export function allowedCommand(command: string, patterns: string[]): boolean {
	const commands = command
		.split(/\s*(?:;|&&)\s*/)
		.map(part => part.trim())
		.filter(part => part);
	return commands.length > 0 && commands.every(part => allowedSingle(part, patterns));
}

/** Commands that could gain privileges, destroy data, affect other processes, or reach other machines, which always need approval */
const riskyCommand =
	/\b(sudo|su|doas|pkexec|run0|dd|mkfs|fdisk|parted|wipefs|shred|shutdown|reboot|poweroff|halt|systemctl|kill|pkill|killall|mount|umount|chown|chmod|crontab|ssh|scp|rsync|eval)\b|\brm\b[^;&|\n]*\s(-\w*[rfR]|--recursive|--force)|\bgit\s+push\b|\|\s*(ba|z)?sh\b|>\s*\/dev\/(?!null\b)/;

/** `cat > file << DELIMITER` or `cat >> file`, then the text and the closing delimiter, and nothing else */
const heredoc =
	/^cat\s+>>?\s*(?<target>\S+)\s+<<(?<strip>-?)\s*(?<quote>['"]?)(?<delimiter>[A-Za-z_][\w-]*)\k<quote>[ \t]*\n(?<body>[\s\S]*?)\n\t*\k<delimiter>[ \t]*\n?$/;

/**
 * The file a Bash command writes, if all it does is write text to one file with a heredoc.
 * An unquoted delimiter lets the shell expand `$`, backticks, and backslashes in the text, so those are only allowed when it is quoted.
 */
export function heredocTarget(command: string): string | undefined {
	const match = heredoc.exec(command.trim());
	if (!match?.groups) return;
	const { target, quote, delimiter, body } = match.groups;
	if (shellSyntax.test(target) || target.split('/').includes('..')) return;
	if (body.split('\n').some(line => line.replace(/^\t*/, '').trimEnd() == delimiter)) return;
	if (!quote && /[$`\\]/.test(body)) return;
	return target;
}

/** Absolute paths a file tool call touches, relative ones resolved against `dir` */
function toolPaths(tool: string, input: Record<string, unknown>, dir: string): string[] {
	const base = resolve(dir, typeof input.path == 'string' ? input.path : '.');
	const paths = [typeof input.file_path == 'string' ? resolve(dir, input.file_path) : base];
	if (tool == 'Glob' && typeof input.pattern == 'string') paths.push(resolve(base, input.pattern));
	return paths;
}

/**
 * Run an agent session.
 * File tools are allowed inside `dir`, `writable`, and `readable` (for reading), anything else needs approval.
 */
export async function runAgent(text: string, options: AgentOptions): Promise<AgentResult> {
	const { dir, readable = [], writable = [] } = options;
	const askTools = ['Bash', ...(options.askTools ?? [])];
	const allowedTools = ['WebSearch', ...(options.yolo ? ['WebFetch'] : []), ...(options.allowedTools ?? [])];

	const decide = (permissionDecision: HookPermissionDecision) => ({
		hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision },
	});

	const guard: HookCallback = async input => {
		if (input.hook_event_name != 'PreToolUse') return {};
		const { tool_name: tool } = input;
		const invalid = await options.validate?.(tool, input.tool_input as Record<string, unknown>);
		if (invalid) return { hookSpecificOutput: { ...decide('deny').hookSpecificOutput, permissionDecisionReason: invalid } };
		if (tool == 'Bash') {
			const command = String((input.tool_input as { command?: unknown }).command ?? '');
			const target = heredocTarget(command);
			const writes = target !== undefined && within(resolve(dir, target), [dir, ...writable]);
			const yolo = options.yolo && !riskyCommand.test(command);
			if (writes || yolo || allowedCommand(command, options.allowedCommands ?? [])) {
				options.onAutoApprove?.(tool, input.tool_input as Record<string, unknown>);
				return decide('allow');
			}
		}
		if (askTools.includes(tool)) return decide('ask');
		if (tool in fileAccess) {
			if (options.yolo) return decide('allow');
			const allowed = fileAccess[tool] == 'write' ? [dir, ...writable] : [dir, ...writable, ...readable];
			const inside = toolPaths(tool, input.tool_input as Record<string, unknown>, dir).every(p => within(p, allowed));
			return decide(inside ? 'allow' : 'ask');
		}
		return allowedTools.includes(tool) ? decide('allow') : {};
	};

	let interaction = Promise.resolve();
	/** Parallel tool calls can need the user at the same time, so they take turns */
	const oneAtATime = <T>(interact: () => Promise<T>): Promise<T> => {
		const result = interaction.then(interact);
		interaction = result.then(
			() => {},
			() => {}
		);
		return result;
	};

	const messages = query({
		prompt: text,
		options: {
			...baseOptions(options.model),
			cwd: dir,
			additionalDirectories: readable,
			resume: options.resume,
			plugins: [{ type: 'local', path: pluginDir }],
			skills: skills(),
			tools: agentTools,
			mcpServers: options.mcpServers,
			permissionMode: options.acceptEdits ? 'acceptEdits' : 'default',
			hooks: { PreToolUse: [{ hooks: [guard] }] },
			async canUseTool(tool, input) {
				if (tool == 'AskUserQuestion') {
					const questions = input.questions as Question[];
					return { behavior: 'allow', updatedInput: { questions, answers: await oneAtATime(() => options.answer(questions)) } };
				}
				const approval = await oneAtATime(() => options.approve(tool, input));
				if (approval === true) return { behavior: 'allow', updatedInput: input };
				const message = approval ? 'The user declined: ' + approval.reason : 'The user did not allow this';
				return { behavior: 'deny', message };
			},
		},
	});

	for await (const message of messages) {
		if (message.type == 'assistant') {
			for (const block of message.message.content) {
				if (block.type == 'text') options.onText?.(block.text);
				else if (block.type == 'tool_use') options.onTool?.(block.name, block.input as Record<string, unknown>);
			}
		}

		if (message.type == 'result') return { text: resultText(message), sessionId: message.session_id, cost: message.total_cost_usd };
	}

	throw new Error('Claude did not respond');
}
