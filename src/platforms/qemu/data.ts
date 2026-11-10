import { Manager } from '@james-pre/config';
import { join } from 'node:path';
import * as z from 'zod';
import { dataDir } from '../../data.js';

export const QemuData = z.object({
	url: z.url().default('qemu:///session'),
	name: z.string().optional(),
	width: z.int().positive().default(1920),
	height: z.int().positive().default(1080),
	/** Pixels removed from each edge of a screenshot before it is handed to the model */
	crop: z
		.object({
			top: z.int().nonnegative().default(130),
			left: z.int().nonnegative().default(350),
			right: z.int().nonnegative().default(300),
			bottom: z.int().nonnegative().default(0),
		})
		.prefault({}),
	scroll: z
		.object({
			/**
			 * `key` sends PageDown/PageUp, so it scrolls whatever has keyboard focus.
			 * `wheel` sends mouse wheel clicks over QMP, so it scrolls whatever is under the pointer.
			 * That does not depend on focus, but needs the pointer to already be over the content
			 * and `qemu-monitor-command` to be allowed.
			 */
			method: z.enum(['key', 'wheel']).default('wheel'),
			direction: z.enum(['down', 'up']).default('down'),
			/** Scroll events sent per page */
			count: z.int().positive().default(7),
			/** Milliseconds between scroll events */
			delay: z.int().nonnegative().default(150),
		})
		.prefault({}),
	/** Milliseconds to let the guest repaint after scrolling */
	renderDelay: z.int().nonnegative().default(1000),
	/**
	 * Milliseconds each key is held while typing.
	 * QEMU paces queued keystrokes by this, so the guest's 16-byte PS/2 queue does not overflow.
	 */
	keyHold: z.int().positive().default(25),
	/** Address the guest reaches the host's loopback interface at, which is 10.0.2.2 with QEMU's user networking */
	hostAddress: z.string().default('10.0.2.2'),
	/** Program the guest opens URLs with, falling back to its default browser if it can not be started */
	browser: z.string().default('chrome'),
	/** Port on the host that the guest's logon hook connects to. Changing it requires running `eedu vm setup` again. */
	logonPort: z.int().min(1).max(65535).default(47613),
});

export interface QemuData extends z.infer<typeof QemuData> {}

export const store = new Manager(QemuData);
store.loadFile(join(dataDir, 'qemu.json'), { create: true });

export const data = store.data;

export function name(): string {
	if (!data.name) throw new Error('No VM configured, run `eedu discover qemu` first');
	return data.name;
}
