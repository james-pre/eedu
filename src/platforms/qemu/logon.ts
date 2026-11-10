import { setTimeout } from 'node:timers/promises';
import { withTimeout } from '../../utils.js';
import { data } from './data.js';
import { start, state } from './domain.js';
import { execute, HostServer, powershellString } from './server.js';

const runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const hookName = 'eedu';

/** Fetches a script from the host at logon, retrying for 10 minutes while nothing is listening, then runs it. */
function hookCommand(): string {
	const url = `http://${data.hostAddress}:${data.logonPort}/logon`;
	return `powershell -nop -w h -c "for($i=0;$i -lt 120;$i++){try{$s=irm ${url};break}catch{sleep 5}};if($s){iex $s}"`;
}

async function executeChecked(script: string): Promise<void> {
	const { output, failed } = await execute(script);
	if (failed) throw new Error(output || 'The script failed in the VM');
}

/** Make the guest contact the host every time a user logs on, which is how {@link boot} knows the desktop is ready. */
export async function installLogonHook(): Promise<void> {
	await executeChecked(
		`Set-ItemProperty -Path ${powershellString(runKey)} -Name ${powershellString(hookName)} -Value ${powershellString(hookCommand())} -ErrorAction Stop`
	);
}

export async function removeLogonHook(): Promise<void> {
	await executeChecked(
		`Remove-ItemProperty -Path ${powershellString(runKey)} -Name ${powershellString(hookName)} -ErrorAction SilentlyContinue`
	);
}

export interface BootOptions {
	/** Seconds to wait for the guest's logon hook */
	timeout?: number;
	/** PowerShell run in the guest at logon */
	script?: string;
}

/**
 * Start the domain and wait until the guest's logon hook reaches the host, meaning a user is logged on and the desktop is up.
 * A domain that is already running or paused is assumed to be logged on already.
 */
export async function boot({ timeout = 300, script = '' }: BootOptions = {}): Promise<void> {
	const current = state();
	if (current == 'running' || current == 'paused') {
		start();
		return;
	}

	const loggedOn = Promise.withResolvers<void>();

	await using _ = await new HostServer()
		.route('/logon', (_, response) => {
			response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(script);
			loggedOn.resolve();
		})
		.start(data.logonPort);

	start();

	await withTimeout(
		loggedOn.promise,
		timeout,
		`The VM did not log on within ${timeout} seconds. Check that Windows logs in automatically and that \`eedu vm setup\` has been run.`
	);

	// Startup apps launched alongside the logon hook can otherwise swallow keystrokes sent right after.
	await setTimeout(3000);
}
