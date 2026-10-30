export interface Chapter {
	sections: ChapterSection[];
	title: string;
	number: number;
}

export interface ChapterSection {
	title: string;
	short_title: string;
	canonical_section_id: number;
	canonical_zybook_id: number;
	canonical_chapter_number: number;
	canonical_section_number: number;
	subject_id: number;
	subject_label: string;
	version: string;
	release_id: number;
	optional: boolean;
	hidden: boolean;
	type: string;
	subject_name: string;
	number: number;
	new: boolean;
}

export interface Section extends ChapterSection {
	content_resources: ContentResource[];
}

export interface ContentResource {
	id: number;
	caption?: string;
	payload: Payload;
	/** Markdown for IT labs */
	instructions?: string | unknown[];
	parts: number;
	activity_type?: string;
	type: string;
	guid?: string;
	release_id: number;
	optional: boolean;
	_number: number;
}

export interface Payload {
	subject: string;
	image_ids: string[];
	tool?: string;
	size: any;
	questions: Question[];
	/** Instructions, steps, and graded goals, for IT labs */
	items?: LabItem[];
	/** The VMs an IT lab runs on */
	vmImages?: VmImage[];
	/** What a programming lab's code is graded against */
	testCases?: TestCase[];
}

/** One run of a programming lab's code, with the output it is expected to produce */
export interface TestCase {
	id: string;
	title: string;
	type: string;
	points: number;
	stdin: string;
	stdout: string;
	argStr: string;
	sourceFile: string;
	hidden: boolean;
	sortWeight: number;
	stdoutCompareMethod: string;
	stdoutCompareOptions: { ignoreCase: boolean; ignoreWhitespace: boolean };
	preserveTrailingNewlines: boolean;
}

export interface LabFile {
	url: string;
	altText?: string;
}

/** The start of a page of lab instructions */
export interface LabPage {
	pageBreak: true;
	instructions: string;
	taskDescription?: string;
	files: LabFile[];
}

/** Something to do on a VM */
export interface LabStep {
	step: true;
	number: number;
	instructions: string;
	files: LabFile[];
}

/** Points awarded when a command run on a VM gives the expected output */
export interface LabGoal {
	goal: true;
	points: number;
	message: string;
	vmImageTests: { command: string; expected: string; run: boolean }[];
}

export type LabItem = LabPage | LabStep | LabGoal;

export interface VmImage {
	name: string;
	title: string;
	instanceType: string;
}

export interface Question {
	text: any[];
	answers?: string[];
	obey_case?: boolean;
	preferred?: string;
	obey_quote?: boolean;
	obey_space?: boolean;
	text_after: any;
	explanation?: any[];
	obey_linear?: boolean;
	render_html?: boolean;
	text_before: any;
	choices: {
		label: { text: string }[];
		correct: boolean;
	}[];
}

/** An IT lab, which is worked through on VMs instead of being answered */
export interface Lab {
	zybook_code: string;
	zybook_id: number;
	/** The subject the lab belongs to, which zyStudio needs to open its workspace */
	subject_id: number;
	name: string;
	resource: ContentResource;
}
