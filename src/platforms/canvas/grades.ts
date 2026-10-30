import type { GradeSource } from '../../grades.js';
import { api } from './api.js';
import { assignmentGroups } from './assignments.js';
import type * as types from './types.js';

export const grades: GradeSource = {
	name: 'canvas',
	has: course => course.canvas_id !== undefined,
	async pull(course) {
		const { apply_assignment_group_weights } = await api<types.Course>('GET', `courses/${course.canvas_id}`);
		const groups = await assignmentGroups(course);

		return groups.map(group => ({
			name: group.name,
			weight: apply_assignment_group_weights ? group.group_weight / 100 : undefined,
			dropped: group.rules?.drop_lowest ?? 0,
			scores: group.assignments
				.filter(a => !a.omit_from_final_grade && a.grading_type != 'not_graded' && !a.submission?.excused)
				.map(a => ({ id: String(a.id), name: a.name, score: a.submission?.score ?? null, possible: a.points_possible ?? 0 })),
		}));
	},
};
