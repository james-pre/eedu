import { setTimeout } from 'node:timers/promises';
import { withTimeout } from '../../utils.js';
import * as canvas from '../canvas/api.js';
import { assertRunning } from './domain.js';
import { HostServer } from './server.js';

export interface CanvasLoginOptions {
	/** Open the address in the guest's browser, instead of only waiting for it to be opened */
	open?: boolean;
	/** Seconds to wait for the guest to open the address */
	timeout?: number;
	/** Called with the address the guest needs to open, once it can be opened */
	onListening?(url: string): void;
}

export async function loginToCanvas(path: string = '/', opts: CanvasLoginOptions = {}) {
	assertRunning();

	if (!canvas.data.origin) throw new Error('Canvas is not set up, run `eedu discover canvas`');

	const target = new URL(path, canvas.data.origin).href;
	const served = Promise.withResolvers<void>();

	await using server = await new HostServer()
		.route('/canvas_login', async (request, response) => {
			const { session_url } = await canvas.api<{ session_url: string }>(
				'GET',
				'login/session_token?return_to=' + encodeURIComponent(target)
			);
			response.writeHead(302, { Location: session_url, 'Cache-Control': 'no-store' }).end();
			served.resolve();
		})
		.start();

	const url = server.url('/canvas_login');
	opts.onListening?.(url);

	if (opts.open) await server.open(url);

	const { timeout = 120 } = opts;
	await withTimeout(served.promise, timeout, `The VM did not open ${url} within ${timeout} seconds`);

	// The first request may have been the browser prefetching, so the real navigation gets a moment to arrive.
	await setTimeout(3000);
}
