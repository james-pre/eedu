import { Manager } from '@james-pre/config';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import * as z from 'zod';
import $pkg from '../../../package.json' with { type: 'json' };
import { dataDir } from '../../data.js';
import { errorText } from 'ioium';

export const CanvasData = z
	.object({
		token: z.string(),
		origin: z.url(),
	})
	.partial();

export interface CanvasData extends z.infer<typeof CanvasData> {}

export const store = new Manager(CanvasData);
store.loadFile(join(dataDir, 'canvas.json'), { create: true });

export const data = store.data;

export class TokenError extends Error {
	constructor() {
		super('Canvas access token is invalid or expired, run `eedu discover canvas` to replace it');
	}
}

export class RequestError extends Error {
	constructor(
		message: string,
		public readonly status: number
	) {
		super(message);
	}
}

async function request(method: string, endpoint: string, body?: any, headers: Record<string, string> = {}) {
	if (!data.origin || !data.token) throw new Error('Canvas is not set up, run `eedu discover canvas`');

	const url = new URL(endpoint, data.origin + '/api/v1/');
	const response = await fetch(url, {
		method,
		body: method == 'GET' || method == 'HEAD' ? null : body instanceof FormData ? body : JSON.stringify(body),
		headers: {
			Authorization: `Bearer ${data.token}`,
			'User-Agent': `Mozilla/5.0 (compatible; eedu/${$pkg.version})`,
			...(!(body instanceof FormData) && { 'Content-Type': 'application/json' }),
			...headers,
		},
	});

	if (response.status == 401 && response.headers.has('WWW-Authenticate')) throw new TokenError();

	const text = await response.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		json = { errors: [{ message: text || response.statusText }] };
	}

	if (!response.ok) {
		const [{ message } = {}] = json.errors || [];
		throw new RequestError(message ?? `${method} ${endpoint} failed: ` + response.statusText, response.status);
	}

	return { response, json };
}

export async function api<T = any>(method: string, endpoint: string, body?: any, headers: Record<string, string> = {}): Promise<T> {
	const { json } = await request(method, endpoint, body, headers);
	return json;
}

/**
 * Create a short-lived, one-time URL that signs a browser into Canvas as the token's user, bypassing SSO.
 * @param returnTo Page to land on, relative to the Canvas origin
 */
export async function sessionURL(returnTo: string = '/'): Promise<string> {
	if (!data.origin) throw new Error('Canvas is not set up, run `eedu discover canvas`');
	const target = new URL(returnTo, data.origin).href;
	const { session_url } = await api<{ session_url: string }>('GET', 'login/session_token?return_to=' + encodeURIComponent(target));
	return session_url;
}

export interface SessionServer extends Disposable {
	port: number;
	/** Resolves once a browser has been redirected to a session */
	served: Promise<void>;
}

/**
 * Serve redirects to fresh Canvas sessions on the host's loopback, minting a new session for every request to `/`.
 * @param returnTo Page to land on, relative to the Canvas origin
 */
export async function serveSession(returnTo: string = '/'): Promise<SessionServer> {
	const { promise: served, resolve } = Promise.withResolvers<void>();

	const server = createServer(async (request, response) => {
		if (request.method != 'GET' || new URL(request.url ?? '/', 'http://localhost').pathname != '/') {
			response.writeHead(404).end();
			return;
		}

		try {
			response.writeHead(302, { Location: await sessionURL(returnTo), 'Cache-Control': 'no-store' }).end();
			resolve();
		} catch (error) {
			response.writeHead(502, { 'Content-Type': 'text/plain' }).end(errorText(error));
		}
	});

	server.listen(0, '127.0.0.1');
	await once(server, 'listening');

	return {
		port: (server.address() as AddressInfo).port,
		served,
		[Symbol.dispose]() {
			server.close();
			server.closeAllConnections();
		},
	};
}

/** GET every page of a list endpoint */
export async function apiAll<T>(endpoint: string): Promise<T[]> {
	const results: T[] = [];
	let next: string | undefined = endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100';
	while (next) {
		const { response, json } = await request('GET', next);
		results.push(...json);
		next = response.headers.get('Link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
	}
	return results;
}
