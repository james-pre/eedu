/**
 * Works without specifying protocol, etc.
 */
export function normalizeURL(url: string): URL {
	if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
	return new URL(url);
}
