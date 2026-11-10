import { errorText } from 'ioium';
import { once } from 'node:events';
import { Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { withTimeout } from '../../utils.js';
import { data } from './data.js';
import { assertRunning } from './domain.js';
import { press, typeText } from './io.js';

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => unknown;

export interface ScriptResult {
	/** Everything the script wrote to any stream, formatted as PowerShell displays it */
	output: string;
	/** Whether the script stopped on a terminating error */
	failed: boolean;
}

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

	/**
	 * Run a PowerShell script in the guest and wait for it to finish, collecting everything it writes.
	 * A script that calls `exit` never reports back, so it times out.
	 * @param timeout Seconds to wait for the script to finish once the guest has fetched it
	 */
	async execute(script: string, timeout: number = 120): Promise<ScriptResult> {
		const path = `/results/${++this.scripts}`;
		const finished = Promise.withResolvers<ScriptResult>();

		this.route(path, async (request, response) => {
			this.routes.delete(path);
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			response.end();
			finished.resolve({
				output: Buffer.concat(chunks).toString('utf-8').trimEnd(),
				failed: new URL(request.url ?? '/', 'http://localhost').searchParams.has('failed'),
			});
		});

		const encoded = Buffer.from(script, 'utf-8').toString('base64');
		const wrapper = [
			"$ProgressPreference = 'SilentlyContinue'",
			'$output = [Collections.Generic.List[object]]::new()',
			"$failed = ''",
			`try { & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))) *>&1 | ForEach-Object { $output.Add($_) } }`,
			"catch { $output.Add($_); $failed = '?failed' }",
			'$text = $output | Out-String -Width 160',
			`irm -Method Post -Uri (${powershellString(this.url(path))} + $failed) -ContentType 'text/plain; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($text))`,
		].join('\n');

		try {
			await this.runScript(wrapper);
			return await withTimeout(finished.promise, timeout, `The script did not finish in the VM within ${timeout} seconds`);
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

/** Run a PowerShell script in the guest through a temporary {@link HostServer}, and wait for it to finish. */
export async function execute(script: string, timeout?: number): Promise<ScriptResult> {
	assertRunning();
	await using server = await new HostServer().start();
	return await server.execute(script, timeout);
}
