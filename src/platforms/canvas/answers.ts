import type { OpenQuiz, Response, ResponseValue, SessionItem } from './quizzes.js';
import { htmlToText, toHTML } from '../../text.js';

/** Item types that are only text to read, with nothing to answer */
const readOnlyTypes = ['text-block'];

/** Item types eedu can't answer, because they need an upload or a click on an image */
const unsupportedTypes = ['file-upload', 'hot-spot'];

/** How each type's answer is written in an answers file */
const answerFormats: Record<string, string> = {
	essay: 'Markdown text',
	choice: 'the chosen choice ID, as a JSON string',
	'multi-answer': 'a JSON array of the chosen choice IDs',
	'true-false': 'true or false',
	numeric: 'the number, as a JSON string',
	formula: 'the number, as a JSON string',
	ordering: 'a JSON array of every choice ID, in order',
	matching: 'a JSON object mapping each question ID to the text of its answer',
	categorization: 'a JSON object mapping each category ID to an array of choice IDs',
	'fill-blank': 'a JSON array of {"id": <blank ID>, "value": <text, or the chosen choice text>}',
	'rich-fill-blank': 'a JSON array of {"id": <blank ID>, "value": <text, or the chosen choice text>}',
};

/** Interaction data with HTML turned into text, which is what the agent needs to see of choices, blanks, and the like */
function plain(value: unknown): unknown {
	if (typeof value == 'string') return /<\w+[^>]*>/.test(value) ? htmlToText(value).trim() : value;
	if (Array.isArray(value)) return value.map(plain);
	if (value && typeof value == 'object')
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key != 'userResponse')
				.map(([key, item]) => [key, plain(item)])
		);
	return value;
}

function itemText(item: SessionItem): string {
	const { slug, name } = item.item.interaction_type;
	const lines = [`## ${item.position}`, `Type: ${name} (${slug})`];

	if (readOnlyTypes.includes(slug)) lines[1] += ', nothing to answer';
	else
		lines.push(
			`Points: ${item.points_possible}`,
			'Answer: '
				+ (unsupportedTypes.includes(slug)
					? 'not supported by eedu, leave it out'
					: (answerFormats[slug] ?? 'see the interaction data'))
		);

	const stimulus = item.stimulus?.body ?? item.stimulus?.item_body;
	if (stimulus) lines.push('', '### Passage' + (item.stimulus?.title ? ': ' + item.stimulus.title : ''), '', htmlToText(stimulus).trim());

	lines.push('', htmlToText(item.item.item_body).trim());

	if (slug == 'essay') {
		const { word_limit_enabled, word_limit_min, word_limit_max } = item.item.interaction_data;
		if (word_limit_enabled) lines.push('', `Word limit: ${word_limit_min ?? 0} to ${word_limit_max ?? 'any'}`);
	} else if (!readOnlyTypes.includes(slug)) {
		lines.push('', 'Interaction data:', '```json', JSON.stringify(plain(item.item.interaction_data), null, '\t'), '```');
	}

	return lines.join('\n');
}

/** The quiz as Markdown, with everything needed to answer it */
export function quizText(quiz: OpenQuiz): string {
	const { session } = quiz;
	const lines = [
		`# ${session.quiz.title}`,
		'Type: ' + (quiz.type ?? session.quiz.quiz_type),
		`Attempt: ${session.attempt}`,
		session.end_at && 'Closes: ' + new Date(session.end_at).toLocaleString(),
		session.quiz.has_time_limit && `Time limit: ${Math.round(session.quiz.session_time_limit_in_seconds / 60)} minutes`,
		'',
		session.quiz.instructions ? htmlToText(session.quiz.instructions).trim() : '',
		'',
		...quiz.items.map(itemText),
	];
	return lines.filter(line => line !== false && line !== null).join('\n');
}

/** Whether a quiz item needs an answer */
export function answerable(item: SessionItem): boolean {
	return !readOnlyTypes.includes(item.item.interaction_type.slug);
}

/** The answer under each `## <position>` heading of an answers file */
export function parseAnswers(text: string): Map<number, string> {
	const answers = new Map<number, string>();
	const sections = text.split(/^##[ \t]+(\d+)\b.*$/m);
	for (let i = 1; i < sections.length; i += 2) answers.set(Number(sections[i]), sections[i + 1].trim());
	return answers;
}

function ids(list: unknown): string[] | undefined {
	if (Array.isArray(list)) return list.map(choice => String(choice?.id));
	if (list && typeof list == 'object') return Object.keys(list);
}

/** Why a value isn't a valid answer to an item, if it isn't */
function invalid(item: SessionItem, value: ResponseValue): string | undefined {
	const { slug } = item.item.interaction_type;
	const choices = ids(item.item.interaction_data.choices);
	const isChoice = (id: unknown) => typeof id == 'string' && (!choices || choices.includes(id));

	switch (slug) {
		case 'choice':
			return isChoice(value) ? undefined : 'expected one of the choice IDs: ' + choices?.join(', ');
		case 'multi-answer':
			return Array.isArray(value) && value.every(isChoice) ? undefined : 'expected an array of choice IDs: ' + choices?.join(', ');
		case 'ordering':
			return Array.isArray(value) && value.every(isChoice) && (!choices || value.length == choices.length)
				? undefined
				: 'expected an array of every choice ID in order: ' + choices?.join(', ');
		case 'true-false':
			return typeof value == 'boolean' ? undefined : 'expected true or false';
		case 'numeric':
		case 'formula':
			return typeof value == 'string' && value.trim() && !isNaN(Number(value)) ? undefined : 'expected a number as a JSON string';
		case 'matching':
		case 'categorization':
			return value && typeof value == 'object' && !Array.isArray(value) ? undefined : 'expected a JSON object';
		case 'fill-blank':
		case 'rich-fill-blank':
			return Array.isArray(value) && value.every(blank => blank && typeof blank == 'object' && 'id' in blank && 'value' in blank)
				? undefined
				: 'expected an array of {"id", "value"} objects';
	}
}

/**
 * The responses in an answers file, checked against the quiz's items.
 * @throws When an answer is missing, isn't valid JSON, or doesn't fit its item
 */
export function quizResponses(quiz: OpenQuiz, text: string): Response[] {
	const answers = parseAnswers(text);
	const problems: string[] = [];
	const responses: Response[] = [];

	for (const position of answers.keys())
		if (!quiz.items.some(item => item.position == position)) problems.push(`${position}: the quiz has no question ${position}`);

	for (const item of quiz.items) {
		const { slug } = item.item.interaction_type;
		const answer = answers.get(item.position);
		if (!answerable(item)) continue;
		if (unsupportedTypes.includes(slug)) {
			if (answer) problems.push(`${item.position}: eedu can't answer ${slug} questions`);
			continue;
		}
		if (!answer) {
			problems.push(`${item.position}: no answer`);
			continue;
		}

		if (slug == 'essay') {
			const rich = item.item.interaction_data.rce !== false;
			responses.push({ position: item.position, value: toHTML({ content: answer, format: rich ? 'markdown' : 'text' }).trim() });
			continue;
		}

		let value: ResponseValue;
		try {
			value = JSON.parse(answer.replace(/^```\w*\n([\s\S]*?)\n```$/, '$1'));
		} catch {
			problems.push(`${item.position}: not valid JSON`);
			continue;
		}

		const reason = invalid(item, value);
		if (reason) problems.push(`${item.position}: ${reason}`);
		else responses.push({ position: item.position, value });
	}

	if (problems.length) throw new Error("The answers can't be submitted yet:\n" + problems.join('\n'));
	return responses;
}
