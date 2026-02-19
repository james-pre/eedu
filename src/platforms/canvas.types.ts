// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Instructure, Inc

/**
 * Extracted from Canvas' OpenAPI data, stripped of comments and fields converted to being non-optional
 */

export interface Term {
	id: number;
	name: string;
	start_at: string;
	end_at: string;
}
export interface CourseProgress {
	requirement_count: number;
	requirement_completed_count: number;
	next_requirement_url: string;
	completed_at: string;
}

export interface Course {
	id: number;
	sis_course_id: string;
	uuid: string;
	integration_id: string;
	sis_import_id: number;
	name: string;
	course_code: string;
	original_name: string;
	workflow_state: 'unpublished' | 'available' | 'completed' | 'deleted';
	account_id: number;
	root_account_id: number;
	enrollment_term_id: number;
	grading_periods: GradingPeriod[];
	grading_standard_id: number;
	grade_passback_setting: string;
	created_at: string;
	start_at: string;
	end_at: string;
	locale: string;
	enrollments: Enrollment[];
	total_students: number;
	calendar: CalendarLink;
	default_view: 'feed' | 'wiki' | 'modules' | 'syllabus' | 'assignments';
	syllabus_body: string;
	needs_grading_count: number;
	term: Term;
	course_progress: CourseProgress;
	apply_assignment_group_weights: boolean;
	permissions: Record<string, never>;
	is_public: boolean;
	is_public_to_auth_users: boolean;
	public_syllabus: boolean;
	public_syllabus_to_auth: boolean;
	public_description: string;
	storage_quota_mb: number;
	storage_quota_used_mb: number;
	hide_final_grades: boolean;
	license: string;
	allow_student_assignment_edits: boolean;
	allow_wiki_comments: boolean;
	allow_student_forum_attachments: boolean;
	open_enrollment: boolean;
	self_enrollment: boolean;
	restrict_enrollments_to_course_dates: boolean;
	course_format: string;
	access_restricted_by_date: boolean;
	time_zone: string;
	template: boolean;
}

export interface CalendarLink {
	ics: string;
}

export interface GradingSchemeEntry {
	name: string;
	value: number;
	calculated_value: number;
}

export interface GradingStandard {
	title: string;
	id: number;
	context_type: string;
	context_id: number;
	points_based: boolean;
	scaling_factor: number;
	grading_scheme: GradingSchemeEntry[];
}

export interface GradingPeriod {
	id: number;
	title: string;
	start_date: string;
	end_date: string;
	close_date: string;
	weight: number;
	is_closed: boolean;
}

export interface ModuleItem {
	id: number;
	duration: number;
	course_pace_id: number;
	root_account_id: number;
	module_item_id: number;
	assignment_title: string;
	points_possible: number;
	assignment_link: string;
	position: number;
	module_item_type: string;
	published: boolean;

	title: string;
	type: 'File' | 'Page' | 'Discussion' | 'Assignment' | 'Quiz' | 'SubHeader' | 'ExternalUrl' | 'ExternalTool';
	external_url?: string;
}

export interface Module {
	id: number;
	name: string;
	position: number;
	items?: ModuleItem[];
	context_id: number;
	context_type: string;

	items_url: string;
}

export interface Grade {
	grade: number;
	total: number;
	possible: number;
	dropped: Record<string, never>[];
}

export interface Enrollment {
	id: number;
	course_id: number;
	sis_course_id: string;
	course_integration_id: string;
	course_section_id: number;
	section_integration_id: string;
	sis_account_id: string;
	sis_section_id: string;
	sis_user_id: string;
	enrollment_state: string;
	limit_privileges_to_course_section: boolean;
	sis_import_id: number;
	root_account_id: number;
	type: string;
	user_id: number;
	associated_user_id: number;
	role: string;
	role_id: number;
	created_at: string;
	updated_at: string;
	start_at: string;
	end_at: string;
	last_activity_at: string;
	last_attended_at: string;
	total_activity_time: number;
	html_url: string;
	grades: Grade;
	user: User;
	override_grade: string;
	override_score: number;
	unposted_current_grade: string;
	unposted_final_grade: string;
	unposted_current_score: string;
	unposted_final_score: string;
	has_grading_periods: boolean;
	totals_for_all_grading_periods_option: boolean;
	current_grading_period_title: string;
	current_grading_period_id: number;
	current_period_override_grade: string;
	current_period_override_score: number;
	current_period_unposted_current_score: number;
	current_period_unposted_final_score: number;
	current_period_unposted_current_grade: string;
	current_period_unposted_final_grade: string;
}

export interface User {
	id: number;
	name: string;
	sortable_name: string;
	last_name: string;
	first_name: string;
	short_name: string;
	sis_user_id: string;
	sis_import_id: number;
	integration_id: string;
	login_id: string;
	avatar_url: string;
	avatar_state: string;
	enrollments: Enrollment[];
	email: string;
	locale: string;
	last_login: string;
	time_zone: string;
	bio: string;
	pronouns: string;
}
