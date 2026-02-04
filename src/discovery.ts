export type Platform = 'canvas' | 'zybooks';

export interface DiscoverHandlers {
	select(question: string, choices: string[], defaultValue?: string): Promise<string> | string;
	prompt(question: string, defaultValue?: string): Promise<string> | string;
	onAdd(...text: string[]): void;
}

export let select: DiscoverHandlers['select'];
export let prompt: DiscoverHandlers['prompt'];
export let onAdd: DiscoverHandlers['onAdd'];

export function setHandlers(handlers: DiscoverHandlers) {
	select = handlers.select;
	prompt = handlers.prompt;
	onAdd = handlers.onAdd;
}

export interface DiscoverOptions {
	recursive?: boolean;
}
