import { _setDebugOutput } from 'ioium';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';

const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'eedu.json');

const Config = z.object({});

export let debugMode = process.argv.includes('--debug');
try {
	debugMode ||= z.stringbool().parse(process.env.EEDU_DEBUG ?? process.env.DEBUG);
	_setDebugOutput(debugMode);
} catch {}
