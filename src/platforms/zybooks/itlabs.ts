import { itlabs } from './api.js';
import type { ContentResource, LabGoal, LabItem, LabPage, LabStep } from './types.js';

/** Whether a lab is worked through on VMs rather than written as code */
export const isItLab = (resource: ContentResource): boolean => resource.type == 'itlab';

/** A goal with the positions zyBooks grades it by */
export interface Goal extends LabGoal {
	/** Position of the goal among the lab's items, which is how grading identifies it */
	index: number;
	/** Position of the VM the goal is graded on */
	instance: number;
}

export const isPage = (item: LabItem): item is LabPage => 'pageBreak' in item;
export const isStep = (item: LabItem): item is LabStep => 'step' in item;
export const isGoal = (item: LabItem): item is LabGoal => 'goal' in item;

/** Every graded goal of a lab, in order */
export function labGoals(resource: ContentResource): Goal[] {
	const goals: Goal[] = [];
	for (const [index, item] of (resource.payload.items ?? []).entries()) {
		if (!isGoal(item)) continue;
		goals.push({
			...item,
			index,
			instance: Math.max(
				item.vmImageTests.findIndex(test => test.run),
				0
			),
		});
	}
	return goals;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Wait for a lab operation, which runs in the background and reports through a status URL */
async function settled<T>(location: string, timeout: number = 600_000): Promise<T> {
	const deadline = Date.now() + timeout;

	for (;;) {
		const status = await itlabs<{ state: string } & T>('GET', location);
		if (status.state == 'SUCCESS') return status;
		if (status.state != 'PENDING') throw new Error('The lab VMs reported ' + status.state.toLowerCase());
		if (Date.now() > deadline) throw new Error('The lab VMs were not ready in time');
		await sleep(5000);
	}
}

/** Another lab still has VMs running, and zyBooks only runs one lab's VMs at a time */
export class LabRunningError extends Error {
	constructor(public readonly resources: number[]) {
		super(`Another lab (${resources.join(', ')}) still has VMs running, and zyBooks only runs one lab's VMs at a time`);
	}
}

/** Start a lab's VMs, which takes a few minutes, and return a URL for each one's screen */
export async function startLab(zybook_code: string, resourceId: number): Promise<string[]> {
	const started = await itlabs<{ location?: string; different_crids_with_running_vm?: number[] }>(
		'POST',
		`zybook/${zybook_code}/content_resource/${resourceId}`,
		{ remote_grading: true }
	);
	if (started.different_crids_with_running_vm?.length) throw new LabRunningError(started.different_crids_with_running_vm);
	if (!started.location) throw new Error('zyBooks did not start the lab VMs');

	const { streaming_urls } = await settled<{ streaming_urls?: string[] }>(started.location);
	if (!streaming_urls?.length) throw new Error('The lab started without any VMs');
	return streaming_urls;
}

/** Shut down a lab's VMs, which are billed for as long as they run */
export async function deleteLab(zybook_code: string, resourceId: number): Promise<void> {
	const { location } = await itlabs<{ location: string }>('DELETE', `zybook/${zybook_code}/content_resource/${resourceId}`);
	await settled(location);
}

/** Which of a lab's points have been earned, one entry per point */
export async function labCompletion(zybook_code: string, resourceId: number): Promise<number[]> {
	const { completed_parts } = await itlabs<{ completed_parts: number[] }>(
		'GET',
		`zybook/${zybook_code}/content_resource/${resourceId}/completion`
	);
	return completed_parts;
}

/** Whether a VM is ready to be graded, which it is once it has finished starting */
export async function gradingReady(zybook_id: number, resourceId: number, instance: number): Promise<boolean> {
	const { is_ready } = await itlabs<{ is_ready: boolean }>('POST', 'grades/is_ready', {
		content_resource_id: resourceId,
		instance_index: instance,
		zybook_id,
	});
	return is_ready;
}

/**
 * Run a goal's test on its VM and record the points if it passes.
 * @returns Whether the goal is now complete
 */
export async function gradeGoal(zybook_id: number, resourceId: number, goal: Goal): Promise<boolean> {
	const { parts } = await itlabs<{ parts: number[] }>('POST', `grades/run_grading/${goal.index}`, {
		content_resource_id: resourceId,
		instance_index: goal.instance,
		zybook_id,
	});
	return parts.includes(1);
}
