export type Platform = 'canvas';

export interface DiscoverOptions {
	select?(question: string, choices: string[], defaultValue?: string): Promise<string> | string;
	prompt?(question: string, defaultValue?: string): Promise<string> | string;
}

export interface Session {
	token: string;
}
