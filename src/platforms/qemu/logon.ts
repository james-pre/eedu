import { setTimeout } from 'node:timers/promises';
import { withTimeout } from '../../utils.js';
import { data } from './data.js';
import { execute, HostServer, powershellString } from './server.js';

const runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const hookName = 'eedu';

/** Tells the host a user has logged on, retrying for 10 minutes while nothing is listening. */
function hookScript(): string {
	const url = `http://${data.hostAddress}:${data.logonPort}/logon`;
	return `for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri ${powershellString(url)} | Out-Null; break } catch { Start-Sleep 5 } }`;
}

async function executeChecked(script: string): Promise<void> {
	const { output, failed } = await execute(script);
	if (failed) throw new Error(output || 'The script failed in the VM');
}

/** Make the guest contact the host every time a user logs on, which is how {@link waitForLogon} knows the desktop is ready. */
export async function installLogonHook(): Promise<void> {
	await executeChecked(
		[
			`$directory = Join-Path $env:LOCALAPPDATA ${powershellString(hookName)}`,
			'New-Item -ItemType Directory -Force -Path $directory -ErrorAction Stop | Out-Null',
			"$file = Join-Path $directory 'logon.ps1'",
			`Set-Content -LiteralPath $file -Value ${powershellString(hookScript())} -Encoding UTF8 -ErrorAction Stop`,
			`Set-ItemProperty -Path ${powershellString(runKey)} -Name ${powershellString(hookName)} -Value "powershell -nop -ep bypass -w h -f \`"$file\`"" -ErrorAction Stop`,
		].join('\n')
	);
}

export async function removeLogonHook(): Promise<void> {
	await executeChecked(
		[
			`Remove-ItemProperty -Path ${powershellString(runKey)} -Name ${powershellString(hookName)} -ErrorAction SilentlyContinue`,
			`Remove-Item -Recurse -Force -LiteralPath (Join-Path $env:LOCALAPPDATA ${powershellString(hookName)}) -ErrorAction SilentlyContinue`,
		].join('\n')
	);
}

/**
 * Wait until the guest's logon hook reaches the host, meaning a user is logged on and the desktop is up.
 * The hook keeps retrying, so this can start after the domain has.
 * @param timeout Seconds to wait for the hook
 */
export async function waitForLogon(timeout: number = 300): Promise<void> {
	const loggedOn = Promise.withResolvers<void>();

	await using _ = await new HostServer()
		.route('/logon', (_, response) => {
			response.writeHead(204).end();
			loggedOn.resolve();
		})
		.start(data.logonPort);

	await withTimeout(
		loggedOn.promise,
		timeout,
		`The VM did not log on within ${timeout} seconds. Check that Windows logs in automatically and that \`eedu vm setup\` has been run.`
	);

	// Startup apps launched alongside the logon hook can otherwise swallow keystrokes sent right after.
	await setTimeout(3000);
}
