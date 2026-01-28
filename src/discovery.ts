import { getCookie } from '@mherod/get-cookie';

export type Platform = 'canvas';

function resolvePlatform(host: string): Platform | null {
	if (host.endsWith('instructure.com')) return 'canvas';
	return null;
}

export interface DiscoverOptions {
	select?(question: string, choices: string[], defaultValue?: string): Promise<string> | string;
}

export interface Session {
	token: string;
	platform?: Platform | null;
	domain: string;
}

const platformCookieNames = {
	canvas: 'canvas_session',
} satisfies Record<Platform, string>;

/**
 * Runs discovery for a "root" site. This is usually a LMS like Canvas.
 * The goal is to use the session token to then make API requests for courses, assignments, etc.
 */
export async function discoverSession(domain: string, opts: DiscoverOptions = {}): Promise<Session> {
	const platform = resolvePlatform(domain);

	let name = platform ? platformCookieNames[platform] : '%';

	const cookies = await getCookie({ domain, name });

	if (name == '%') {
		if (!opts.select) throw `Can not resolve cookie name for "${domain}"`;
		name = await opts?.select(
			'Select cookie name',
			cookies.map(c => c.name)
		);
	}

	console.debug(cookies.map(c => c.name));

	const cookie = cookies.find(c => c.name == name);
	if (!cookie) throw `Couldn't find cookie "${name}" for "${domain}"`;
	return { token: cookie.value, platform, domain };
}
