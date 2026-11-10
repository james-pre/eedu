import { errorText } from 'ioium';
import { once } from 'node:events';
import { Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { data } from './data.js';

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => unknown;

/**
 * An HTTP server on the host's loopback interface, which the guest reaches at {@link QemuData.hostAddress}.
 * Requests to unrouted paths get a 404, and handler errors are sent back as a 500.
 */
export class HostServer extends HTTPServer implements AsyncDisposable {
	protected readonly routes = new Map<string, RouteHandler>();

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

	/** Stop listening and drop open connections, including idle keep-alive ones from the guest's browser. */
	async [Symbol.asyncDispose](): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.close(() => resolve());
		this.closeAllConnections();
		await promise;
	}
}
