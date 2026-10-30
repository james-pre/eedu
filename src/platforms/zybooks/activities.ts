import { createHash } from 'node:crypto';
import $pkg from '../../../package.json' with { type: 'json' };
import { api, data } from './api.js';
import type { Chapter, ChapterSection, ContentResource, Lab, Section } from './types.js';

// Regex to match: <meta name="zybooks-web/config/environment" content="...">
const buildConfigRegex = /<meta\b[^>]*\bname="zybooks-web\/config\/environment"[^>]*\bcontent=(["'])(?<content>(?:\\.|(?!\1).)*)\1/i;

export async function getBuildKey() {
	const res = await fetch('https://learn.zybooks.com', {
		headers: {
			'User-Agent': `Mozilla/5.0 (compatible; eedu/${$pkg.version})`,
			Authorization: `Bearer ${data.token}`,
		},
	});
	const content = await res.text();

	const match = content.match(buildConfigRegex);
	if (!match) throw new Error('Could not find build key');

	const config = JSON.parse(decodeURIComponent(match.groups!.content));
	return config.APP.BUILDKEY;
}

export function resourceName(chapter: Chapter, section: ChapterSection, resource: ContentResource, names: boolean): string {
	let text = `${chapter.number}.${section.number}.${resource._number}`;
	if (names) text += ` [${chapter.title} > ${section.title}${resource.caption ? ' > ' + resource.caption : ''}]`;
	return text;
}

/** The parts of each activity in a book that zyBooks has recorded as complete, by resource ID */
export async function completedParts(zybook_code: string): Promise<Map<number, number[]>> {
	const response = await api<{ data: unknown }>('GET', `zybook/${zybook_code}/activities/${data.user_id}`);
	const parts = new Map<number, number[]>();

	const collect = (value: unknown): void => {
		if (Array.isArray(value)) return value.forEach(collect);
		if (!value || typeof value != 'object') return;
		for (const [id, entry] of Object.entries(value)) {
			if (Array.isArray(entry) && entry.every(part => typeof part == 'number')) parts.set(Number(id), entry);
			else collect(entry);
		}
	};

	collect(response.data);
	return parts;
}

/** Whether zyBooks has recorded every part of an activity as complete */
function isComplete(resource: ContentResource, completed: Map<number, number[]>): boolean {
	const parts = completed.get(resource.id);
	return !!parts?.length && parts.length >= resource.parts && parts.every(part => part >= 1);
}

export interface AutoOptions {
	/** Chapters to auto-complete, by default all of them */
	chapters?: number[];
	section?: number;
	/** Activities to leave alone, like `1.2.3`, or every activity in a section or chapter, like `1.2` or `1` */
	skip?: string[];
	delay?: number;
	dryRun: boolean;
	force: boolean;
	showNames: boolean;
	onSkip?(name: string, resource: ContentResource, reason: string, show?: boolean): void;
	onComplete?(name: string, resource: ContentResource, part?: number): void;
	/** Work through a lab. Labs are skipped when this is unset. */
	onLab?(lab: Lab): Promise<void>;
}

let buildKey: string;

function createBody(zybook_code: string, resourceId: number, part: number, extra?: any): object {
	const timestamp = new Date().toISOString();
	const md5 = createHash('md5');
	const raw = `content_resource/${resourceId}/activity${timestamp}${data.token}${resourceId}${part}true${buildKey}`;
	md5.update(raw, 'utf8');
	const __cs__ = md5.digest('hex');

	return {
		part,
		complete: true,
		metadata: {
			isTrusted: true,
			computerTime: timestamp,
			...(extra?.metadata || {}),
		},
		zybook_code,
		auth_token: data.token,
		timestamp,
		__cs__,
		...extra,
	};
}

export async function autoComplete(zybook_code: string, opts: AutoOptions) {
	if (!data.token || !data.user_id) throw new Error('Missing session information');

	function delay() {
		if (!opts.delay) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, opts.delay);
		return promise;
	}

	buildKey = await getBuildKey();

	const {
		zybooks: [{ chapters, zybook_id }],
	} = await api<{ zybooks: { chapters: Chapter[]; zybook_id: number }[] }>('GET', `zybooks?zybooks=["${zybook_code}"]`);

	const completed = await completedParts(zybook_code);

	for (const chapter of chapters) {
		if (opts.chapters?.length && !opts.chapters.includes(chapter.number)) continue;

		for (const section of chapter.sections) {
			if (typeof opts.section == 'number' && section.number != opts.section) continue;

			const {
				section: { content_resources },
			} = await api<{ section: Section }>('GET', `zybook/${zybook_code}/chapter/${chapter.number}/section/${section.number}`).catch(
				() =>
					api<{ section: Section }>(
						'GET',
						`zybook/${zybook_code}/chapter/${chapter.number}/section/${section.canonical_section_number}`
					)
			);

			for (const [i, resource] of content_resources.entries()) {
				resource._number = i + 1;
				const name = resourceName(chapter, section, resource, opts.showNames);
				const number = `${chapter.number}.${section.number}.${resource._number}`;
				if (opts.skip?.some(skipped => number == skipped || number.startsWith(skipped + '.'))) {
					opts.onSkip?.(name, resource, 'skipped with --skip', true);
					continue;
				}
				if (resource.activity_type != 'lab' && isComplete(resource, completed) && !opts.force) {
					opts.onSkip?.(name, resource, 'already completed');
					continue;
				}
				if (resource.activity_type == 'lab') {
					if (!opts.onLab) opts.onSkip?.(name, resource, 'labs are only done with --labs', true);
					else if (opts.dryRun) opts.onSkip?.(name, resource, 'dry run', true);
					else await opts.onLab({ zybook_code, zybook_id, subject_id: section.subject_id, name, resource });
					continue;
				}
				switch (resource.type) {
					case 'container':
					case 'html':
						break;
					case 'multiple_choice':
						for (const [part, question] of resource.payload.questions.entries()) {
							const answer = question.choices.find(c => c.correct)!.label[0].text;
							const body = createBody(zybook_code, resource.id, part, { answer });
							opts.onComplete?.(name, resource, part);
							if (!opts.dryRun) await api('POST', `content_resource/${resource.id}/activity`, body);
							await delay();
						}
						break;
					case 'short_answer':
						for (const [part, question] of resource.payload.questions.entries()) {
							const answer = question.preferred;
							const body = createBody(zybook_code, resource.id, part, {
								answer,
								metadata: {
									caseDiffers: false,
									quoteDiffers: false,
									stringDiffHighlight: null,
									type: 'correct',
									whitespaceDiffers: false,
									isTrusted: { isTrusted: true },
								},
							});
							opts.onComplete?.(name, resource, part);
							if (!opts.dryRun) await api('POST', `content_resource/${resource.id}/activity`, body);
							await delay();
						}
						break;
					default:
					case 'custom':
						for (let part = 0; part < resource.parts; part++) {
							const body = createBody(zybook_code, resource.id, part);
							opts.onComplete?.(name, resource, part);
							if (!opts.dryRun) await api('POST', `content_resource/${resource.id}/activity`, body);
							await delay();
						}
						break;
				}
			}
		}
	}
}
