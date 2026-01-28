import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'eedu');
mkdirSync(dataDir, { recursive: true });
