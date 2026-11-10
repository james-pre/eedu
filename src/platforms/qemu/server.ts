import { errorText } from 'ioium';
import { once } from 'node:events';
import { Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { withTimeout } from '../../utils.js';
import { data } from './data.js';
import { press, typeText } from './io.js';

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => unknown;

export function powershellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * An HTTP server on the host's loopback interface, which the guest reaches at {@link QemuData.hostAddress}.
 * Requests to unrouted paths get a 404, and handler errors are sent back as a 500.
 */
export class HostServer extends HTTPServer implements AsyncDisposable {
	protected readonly routes = new Map<string, RouteHandler>();
	private scripts = 0;

	constructor() {
		super((request, response) => this.handle(request, response));
	}

	protected async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const { pathname } = new URL(request.url ?? '/', 'http://localhost');
		const handler = this.routes.get(pathname);

		if (!handler) {
			response.writeHead(404).end();
			return;
		}

		try {
			await handler(request, response);
		} catch (error) {
			if (response.headersSent) response.destroy();
			else response.writeHead(500, { 'Content-Type': 'text/plain' }).end(errorText(error));
		}
	}

	route(path: string, handler: RouteHandler): this {
		this.routes.set(path, handler);
		return this;
	}

	/** Listen on the host's loopback interface, on a random port unless one is given. */
	async start(port: number = 0): Promise<this> {
		this.listen(port, '127.0.0.1');
		await once(this, 'listening');
		return this;
	}

	get port(): number {
		const address = this.address() as AddressInfo | null;
		if (!address) throw new Error('Host server is not listening');
		return address.port;
	}

	/** The URL the guest opens to reach `path` */
	url(path: string = '/'): string {
		return new URL(path, `http://${data.hostAddress}:${this.port}`).href;
	}

	/**
	 * Run a PowerShell script in the guest by typing a short command into the Run dialog that downloads it from this server.
	 * Resolves once the guest has fetched the script, not once it has finished running.
	 * @param timeout Seconds to wait for the guest to fetch the script
	 */
	async runScript(script: string, timeout: number = 30): Promise<void> {
		const path = `/scripts/${++this.scripts}`;
		const fetched = Promise.withResolvers<void>();

		this.route(path, (_, response) => {
			this.routes.delete(path);
			response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(script);
			fetched.resolve();
		});

		try {
			await press('KEY_LEFTMETA', 'KEY_R');
			await setTimeout(500);
			await typeText(`powershell -nop -w h -c irm ${this.url(path)}|iex\n`);
			await withTimeout(fetched.promise, timeout, `The VM did not fetch ${this.url(path)} within ${timeout} seconds`);
		} finally {
			this.routes.delete(path);
		}
	}

	/** Open `url` in the guest with {@link QemuData.browser} */
	async open(url: string): Promise<void> {
		const browser = powershellString(data.browser);
		const target = powershellString(url);
		await this.runScript(`try { Start-Process ${browser} ${target} -ErrorAction Stop } catch { Start-Process ${target} }`);
	}

	/** Stop listening and drop open connections, including idle keep-alive ones from the guest's browser. */
	async [Symbol.asyncDispose](): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.close(() => resolve());
		this.closeAllConnections();
		await promise;
	}
}
