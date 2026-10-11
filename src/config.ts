import { Manager } from '@james-pre/config';
import { _setDebugOutput } from 'ioium';
import { join } from 'node:path';
import * as z from 'zod';
import { dataDir } from './data.js';

export const Config = z.object({
	/** Claude model used for automation */
	llm: z.string().default('claude-opus-5-5'),
	llm_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
	/** Arguments for pandoc when building PDFs from Markdown */
	pandoc: z.string().array().default(['--from=markdown+tex_math_dollars+raw_tex+subscript+superscript', '--pdf-engine=xelatex']),
});

export interface Config extends z.infer<typeof Config> {}

export const store = new Manager(Config);
store.loadFile(join(dataDir, 'config.json'), { create: true });

export const config = store.data;

export let debugMode = process.argv.includes('--debug');
try {
	debugMode ||= z.stringbool().parse(process.env.EEDU_DEBUG ?? process.env.DEBUG);
	_setDebugOutput(debugMode);
} catch {}
