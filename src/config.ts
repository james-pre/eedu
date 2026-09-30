import { _setDebugOutput } from 'ioium';
import * as z from 'zod';

export let debugMode = process.argv.includes('--debug');
try {
	debugMode ||= z.stringbool().parse(process.env.EEDU_DEBUG ?? process.env.DEBUG);
	_setDebugOutput(debugMode);
} catch {}
