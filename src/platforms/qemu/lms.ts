import { errorText } from 'ioium';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import * as canvas from '../canvas/api.js';
import { data } from './data.js';
import { assertRunning } from './domain.js';
import { press, typeText } from './io.js';

export interface CanvasLoginOptions {
	type?: boolean;
	focus?: boolean;
	timeout?: number;
}

export async function loginToCanvas(path: string = '/', opts: CanvasLoginOptions = {}) {
	assertRunning();

	if (!canvas.data.origin) throw new Error('Canvas is not set up, run `eedu discover canvas`');

	const target = new URL(path, canvas.data.origin).href;

	const served = Promise.withResolvers<void>();

	const server = createServer(async (request, response) => {
		if (request.method != 'GET' || new URL(request.url ?? '/', 'http://localhost').pathname != '/') {
			response.writeHead(404).end();
			return;
		}

		try {
			const { session_url } = await canvas.api<{ session_url: string }>(
				'GET',
				'login/session_token?return_to=' + encodeURIComponent(target)
			);
			response.writeHead(302, { Location: session_url, 'Cache-Control': 'no-store' }).end();
			served.resolve();
		} catch (error) {
			response.writeHead(502, { 'Content-Type': 'text/plain' }).end(errorText(error));
		}
	});

	server.listen(0, '127.0.0.1');
	await once(server, 'listening');

	const { port } = server.address() as AddressInfo;

	using _ = {
		[Symbol.dispose]() {
			server.close();
			server.closeAllConnections();
		},
	};

	const url = `http://${data.hostAddress}:${port}`;

	if (opts.type) {
		if (opts.focus) {
			await press('KEY_LEFTCTRL', 'KEY_L');
			await setTimeout(300);
		}
		await typeText(url + '\n');
	}

	const { timeout = 120 } = opts;
	const result = await Promise.race([served.promise, setTimeout(timeout * 1000, 'timeout', { ref: false })]);
	if (result == 'timeout') throw new Error(`The VM did not open ${url} within ${timeout} seconds`);

	// The first request may have been the browser prefetching, so the real navigation gets a moment to arrive.
	await setTimeout(3000);
}
