import type { AssignmentSource, PulledAssignment, SubmissionType } from '../../assignments.js';
import type { Course } from '../../data.js';
import { toHTML } from '../../text.js';
import { api, apiAll, RequestError } from './api.js';
import { assignmentDiscussion, postEntry } from './discussions.js';
import { linkedFiles, upload } from './files.js';
import { isQuizTool } from './quizzes.js';
import type * as types from './types.js';

interface AssignmentGroup extends Omit<types.AssignmentGroup, 'assignments'> {
	assignments: types.Assignment[];
}

export function assignmentGroups(course: Course): Promise<AssignmentGroup[]> {
	return apiAll<AssignmentGroup>(`courses/${course.canvas_id}/assignment_groups?include[]=assignments&include[]=submission`);
}

const submissionTypes: Record<types.Assignment['submission_types'][number], SubmissionType> = {
	online_text_entry: 'text',
	online_url: 'url',
	online_upload: 'file',
	external_tool: 'external',
	online_quiz: 'quiz',
	discussion_topic: 'discussion',
	media_recording: 'media',
	student_annotation: 'annotation',
	on_paper: 'paper',
	none: 'none',
	not_graded: 'none',
};

const date = (value?: string | null) => (value ? new Date(value) : undefined);

function typesOf(assignment: types.Assignment): SubmissionType[] {
	const quiz = isQuizTool(assignment.external_tool_tag_attributes?.url);
	return [...new Set(assignment.submission_types.map(t => (t == 'external_tool' && quiz ? 'quiz' : submissionTypes[t])))];
}

function toPulled(assignment: types.Assignment, category?: string): PulledAssignment {
	const { submission } = assignment;
	const state = submission?.workflow_state;
	return {
		id: String(assignment.id),
		name: assignment.name,
		category,
		description: assignment.description || undefined,
		due: date(assignment.due_at),
		unlock: date(assignment.unlock_at),
		lock: date(assignment.lock_at),
		locked: assignment.locked_for_user,
		possible: assignment.points_possible ?? 0,
		score: submission?.score ?? null,
		status: state == 'graded' ? 'graded' : state == 'submitted' || state == 'pending_review' ? 'submitted' : 'unsubmitted',
		late: !!submission?.late,
		missing: !!submission?.missing,
		types: typesOf(assignment),
		extensions: assignment.allowed_extensions?.length ? assignment.allowed_extensions : undefined,
		url: assignment.html_url,
	};
}

export const assignments: AssignmentSource = {
	name: 'canvas',
	has: course => course.canvas_id !== undefined,
	async list(course) {
		const groups = await assignmentGroups(course);
		return groups.flatMap(group => group.assignments.map(a => toPulled(a, group.name)));
	},
	async get(course, id) {
		try {
			const assignment = await api<types.Assignment>('GET', `courses/${course.canvas_id}/assignments/${id}?include[]=submission`);
			const group = await api<types.AssignmentGroup>(
				'GET',
				`courses/${course.canvas_id}/assignment_groups/${assignment.assignment_group_id}`
			);
			return toPulled(assignment, group.name);
		} catch (e) {
			if (e instanceof RequestError && e.status == 404) return;
			throw e;
		}
	},
	async attachments(course, id) {
		const assignment = await api<types.Assignment>('GET', `courses/${course.canvas_id}/assignments/${id}`);
		return linkedFiles(course, assignment.description ?? '');
	},
	async submit(course, id, submission, { comment }) {
		const endpoint = `courses/${course.canvas_id}/assignments/${id}/submissions`;

		const topic = submission.type == 'text' && (await assignmentDiscussion(course, Number(id)));
		if (topic) {
			if (comment) throw new Error('Comments are not supported for discussion posts');
			await postEntry(course, topic.id, toHTML(submission.text));
			return;
		}

		const body =
			submission.type == 'text'
				? { submission_type: 'online_text_entry', body: toHTML(submission.text) }
				: submission.type == 'url'
					? { submission_type: 'online_url', url: submission.url }
					: {
							submission_type: 'online_upload',
							file_ids: await Promise.all(submission.paths.map(path => upload(endpoint + '/self/files', path))),
						};

		await api('POST', endpoint, { submission: body, ...(comment && { comment: { text_comment: comment } }) });
	},
};
