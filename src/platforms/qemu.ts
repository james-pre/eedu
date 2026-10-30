import { Manager } from '@james-pre/config';
import * as io from 'ioium/node';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempDisposableSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, machine, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { debugMode } from '../config.js';
import { dataDir } from '../data.js';
import { onAdd, prompt, select } from '../discovery.js';
import * as llm from '../llm.js';
import XMLBuilder from 'fast-xml-builder';

export const QemuData = z.object({
	url: z.url().default('qemu:///session'),
	name: z.string().optional(),
	width: z.int().positive().default(1920),
	height: z.int().positive().default(1080),
	/** Pixels removed from each edge of a screenshot before it is handed to the model */
	crop: z
		.object({
			top: z.int().nonnegative().default(130),
			left: z.int().nonnegative().default(350),
			right: z.int().nonnegative().default(300),
			bottom: z.int().nonnegative().default(0),
		})
		.prefault({}),
	scroll: z
		.object({
			/**
			 * `key` sends PageDown/PageUp, so it scrolls whatever has keyboard focus.
			 * `wheel` sends mouse wheel clicks over QMP, so it scrolls whatever is under the pointer.
			 * That does not depend on focus, but needs the pointer to already be over the content
			 * and `qemu-monitor-command` to be allowed.
			 */
			method: z.enum(['key', 'wheel']).default('wheel'),
			direction: z.enum(['down', 'up']).default('down'),
			/** Scroll events sent per page */
			count: z.int().positive().default(7),
			/** Milliseconds between scroll events */
			delay: z.int().nonnegative().default(150),
		})
		.prefault({}),
	/** Milliseconds to let the guest repaint after scrolling */
	renderDelay: z.int().nonnegative().default(1000),
});

export interface QemuData extends z.infer<typeof QemuData> {}

export const store = new Manager(QemuData);
store.loadFile(join(dataDir, 'qemu.json'), { create: true });

export const data = store.data;

/** Screenshots are kept here only while they're being used */
const tempPrefix = join(tmpdir(), 'eedu-qemu-');

/** `virsh screenshot` has to round-trip the guest's framebuffer, Claude has to think. */
const timeouts = { virsh: 30_000, claude: 300_000 };

/**
 * Run a command and return its stdout.
 * A tracked "Doing something... done." line for every screenshot, scroll event, and page
 * buries the answers, so the status line is only shown when debugging.
 */
function run(text: string, timeout: number, command: string, ...args: string[]): string {
	if (debugMode) {
		io.setCommandTimeout(timeout);
		return io.trackCommand({ text }, command, ...args);
	}

	try {
		return execFileSync(command, args, { encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e: any) {
		const stderr = typeof e?.stderr == 'string' ? e.stderr.trim() : '';
		throw new Error(stderr.slice(0, 200) || io.errorText(e));
	}
}

function virsh(text: string, ...args: string[]): string {
	return run(text, timeouts.virsh, 'virsh', '-c', data.url, ...args);
}

function domain(): string {
	if (!data.name) throw new Error('No VM configured, run `eedu discover qemu` first');
	return data.name;
}

function assertRunning(): void {
	const state = virsh(`Checking ${domain()}`, 'domstate', domain()).trim();
	if (state != 'running')
		throw new Error(`Domain '${domain()}' is not ${state == 'shut off' ? 'running' : `running (${state})`} on ${data.url}`);
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Capture the guest's screen, crop it, and write it to `path`.
 * Returns the dimensions of the cropped image.
 */
export async function screenshot(path: string): Promise<{ width: number; height: number }> {
	// sharp can not read and write the same file, so the raw capture gets its own path.
	const raw = path + '.raw.png';
	virsh('Capturing screenshot', 'screenshot', domain(), '--file', raw);

	try {
		const image = sharp(raw);
		const { width = 0, height = 0 } = await image.metadata();

		const { top, left, right, bottom } = data.crop;
		const cropped = { width: width - left - right, height: height - top - bottom };

		if (cropped.width <= 0 || cropped.height <= 0)
			throw new Error(`${width}x${height} is too small to crop (${left}+${right} wide, ${top}+${bottom} tall)`);

		await image
			.extract({ left, top, ...cropped })
			.png()
			.toFile(path);
		return cropped;
	} finally {
		rmSync(raw, { force: true });
	}
}

/** Scroll the guest. Whatever has focus (`key`) or is under the pointer (`wheel`) moves. */
export async function scroll(count: number = data.scroll.count): Promise<void> {
	const { method, direction, delay } = data.scroll;

	const key = direction == 'down' ? 'KEY_PAGEDOWN' : 'KEY_PAGEUP';
	const button = direction == 'down' ? 'wheel-down' : 'wheel-up';

	// A wheel click is a press+release of a virtual button.
	const event = JSON.stringify({
		execute: 'input-send-event',
		arguments: {
			events: [
				{ type: 'btn', data: { down: true, button } },
				{ type: 'btn', data: { down: false, button } },
			],
		},
	});

	for (let i = 0; i < count; i++) {
		const text = `Scrolling ${direction}` + (count > 1 ? ` (${i + 1}/${count})` : '');
		try {
			if (method == 'key') virsh(text, 'send-key', domain(), '--codeset', 'linux', '--holdtime', '50', key);
			else virsh(text, 'qemu-monitor-command', domain(), event);
		} catch (e) {
			io.warn('could not scroll:', io.errorText(e));
			return;
		}
		await sleep(delay);
	}
}

export async function discover() {
	const url = await prompt('Enter the libvirt connection URI: ', data.url);
	data.url = url.trim() || data.url;

	const domains = virsh('Listing domains', 'list', '--all', '--name')
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean);

	if (!domains.length) throw new Error(`No domains found on ${data.url}`);

	const name = await select('Select the VM', domains, data.name ?? domains[0]);
	data.name = name.trim() || data.name || domains[0];

	if (!domains.includes(data.name)) throw new Error(`No domain '${data.name}' on ${data.url}`);

	store.update({ url: data.url, name: data.name });

	// The only reliable way to learn the guest's resolution is to look at it.
	assertRunning();

	using temp = mkdtempDisposableSync(tempPrefix);
	const probe = join(temp.path, 'probe.png');
	virsh('Capturing screenshot', 'screenshot', data.name, '--file', probe);
	const { width, height } = await sharp(probe).metadata();
	if (!width || !height) throw new Error('Could not read the screenshot dimensions');
	data.width = width;
	data.height = height;

	store.update({ width: data.width, height: data.height });

	onAdd('vm', `${data.name} (${data.width}x${data.height})`);

	const { top, left, right, bottom } = data.crop;
	if (data.width - left - right <= 0 || data.height - top - bottom <= 0)
		io.warn(
			`Crop (${left}+${right} wide, ${top}+${bottom} tall) is too large for ${data.width}x${data.height}, edit ${join(dataDir, 'qemu.json')}`
		);
}

export interface AutoOptions {
	/** Stop after this many screenfuls */
	pages: number;
	/** Answer but never scroll, which means a single useful pass */
	scroll: boolean;
	/** Scroll once before the first screenshot, for pages that start above the questions */
	initialScroll: number;
	/** Answers file. When unset, answers are only reported through {@link AutoOptions.onAnswer} */
	out?: string;
	/** Ask for a one-line reason with each answer */
	explain: boolean;
	/** Append to an existing answers file, skipping questions already recorded in it. */
	resume: boolean;
	onResume?(count: number, out: string): void;
	onAnswer?(line: string): void;
	onPage?(page: number, added: number, total: number): void;
	onDone?(total: number, out?: string): void;
	onError?(page: number, error: unknown): void;
}

/**
 * Screenshot the guest, answer whatever questions are on screen, scroll, and repeat until the screen stops changing.
 */
export async function autoComplete(opts: AutoOptions) {
	if (!Number.isInteger(opts.pages) || opts.pages < 1) throw new Error('--pages must be a positive integer');

	assertRunning();

	using temp = mkdtempDisposableSync(tempPrefix);
	const image = join(temp.path, 'questions.png');
	const { out } = opts;

	const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').slice(0, 15);

	const seen = new Set<number>();
	if (out && opts.resume && existsSync(out)) {
		for (const [, n] of readFileSync(out, 'utf-8').matchAll(/^Q(\d+)/gm)) seen.add(+n);
		opts.onResume?.(seen.size, out);
	} else if (out) {
		writeFileSync(out, `# Answers — ${runId}\n\n`);
	}

	if (opts.initialScroll) {
		await scroll(opts.initialScroll);
		await sleep(data.renderDelay);
	}

	let previous = '';
	let total = 0;
	let page = 0;

	while (page < opts.pages) {
		page++;

		await screenshot(image);

		const hash = createHash('sha256').update(readFileSync(image)).digest('hex');
		if (hash == previous) {
			io.info(`page ${page}: screen unchanged after scrolling, end of questions`);
			page--;
			break;
		}
		previous = hash;

		let added = 0;
		try {
			const output = await llm.ask(
				llm.prompt('qemu-questions', { image, explain: opts.explain ? ' — <one short sentence of reasoning>' : '' }),
				{ tools: ['Read'], cwd: temp.path, timeout: timeouts.claude }
			);

			for (const line of output.split('\n').filter(line => /^Q\d+:/.test(line))) {
				const number = +line.slice(1, line.indexOf(':'));
				if (seen.has(number)) continue;
				seen.add(number);
				if (out) appendFileSync(out, line + '\n\n');
				opts.onAnswer?.(line);
				added++;
			}
		} catch (e) {
			opts.onError?.(page, e);
		}

		total += added;
		opts.onPage?.(page, added, total);

		if (!opts.scroll) break;

		await scroll();
		await sleep(data.renderDelay);
	}

	opts.onDone?.(total, out);
}

export interface DomainInit {
	name: string;
	title?: string;
	/** In MiB. Defaults to half of the host's memory, rounded down to a power of two. */
	memory?: number;
	disk: {
		/** Path to a qcow2 image */
		path: string;
		model: string;
		serial: string;
	};
	/** Defaults to a random Realtek address */
	mac?: string;
	/** Defaults to the configured screen size */
	resolution?: { width: number; height: number };
	/** SMBIOS tables. The system UUID is filled in with the domain's. */
	sysinfo: {
		bios: Record<string, string>;
		system: Record<string, string>;
		baseBoard: Record<string, string>;
		chassis: Record<string, string>;
		oemStrings: string[];
	};
	/** SMBIOS type 17 fields */
	memoryModule: {
		manufacturer: string;
		/** In MT/s */
		speed: number;
		part: string;
	};
}

const cpuVendors: [RegExp, string][] = [
	[/AMD/, 'Advanced Micro Devices, Inc.'],
	[/Intel/, 'Intel(R) Corporation'],
];

function threadsPerCore(): number {
	try {
		return readFileSync('/sys/devices/system/cpu/smt/active', 'utf-8').trim() == '1' ? 2 : 1;
	} catch {
		return 1;
	}
}

function smbiosEntries(fields: Record<string, string>) {
	return Object.entries(fields).map(([name, value]) => ({ '@name': name, '#text': value }));
}

/** Format fields as the value of a QEMU `-smbios` option. */
function smbiosOption(type: number, fields: Record<string, string | number>): string {
	const values = Object.entries(fields).map(([key, value]) => `${key}=${String(value).replaceAll(',', ',,')}`);
	return [`type=${type}`, ...values].join(',');
}

function pciAddress(bus: number, slot: number, func: number = 0) {
	const hex = (value: number) => '0x' + value.toString(16).padStart(2, '0');
	return { '@type': 'pci', '@domain': '0x0000', '@bus': hex(bus), '@slot': hex(slot), '@function': '0x' + func.toString(16) };
}

function rootPort(index: number, func: number) {
	return {
		'@type': 'pci',
		'@index': index,
		'@model': 'pcie-root-port',
		model: { '@name': 'pcie-root-port' },
		target: { '@chassis': index, '@port': '0x' + (0x10 + func).toString(16) },
		address: { ...pciAddress(0, 2, func), ...(func == 0 && { '@multifunction': 'on' }) },
	};
}

export function createDomainXML(init: DomainInit): string {
	const uuid = randomUUID();

	const processors = cpus();
	const cpuModel = processors[0].model.trim();
	const threads = threadsPerCore();
	const cpuManufacturer = cpuVendors.find(([pattern]) => pattern.test(cpuModel))?.[1];

	const memory = init.memory ?? 2 ** Math.floor(Math.log2(totalmem() / 2 / 2 ** 20));
	const mac = init.mac ?? '00:e0:4c:' + Array.from(randomBytes(3), byte => byte.toString(16).padStart(2, '0')).join(':');
	const { width, height } = init.resolution ?? data;

	const builder = new XMLBuilder({
		format: true,
		indentBy: '\t',
		ignoreAttributes: false,
		attributeNamePrefix: '@',
		suppressEmptyNode: true,
	});

	return builder.build({
		domain: {
			'@type': 'kvm',
			'@xmlns:qemu': 'http://libvirt.org/schemas/domain/qemu/1.0',
			name: init.name,
			uuid,
			...(init.title && { title: init.title }),
			memory: { '@unit': 'MiB', '#text': memory },
			currentMemory: { '@unit': 'MiB', '#text': memory },
			vcpu: { '@placement': 'static', '#text': processors.length },
			os: {
				'@firmware': 'efi',
				type: { '@arch': machine(), '@machine': 'q35', '#text': 'hvm' },
				firmware: {
					feature: [
						{ '@enabled': 'yes', '@name': 'enrolled-keys' },
						{ '@enabled': 'yes', '@name': 'secure-boot' },
					],
				},
				boot: { '@dev': 'hd' },
				bootmenu: { '@enable': 'yes' },
				smbios: { '@mode': 'sysinfo' },
			},
			sysinfo: {
				'@type': 'smbios',
				bios: { entry: smbiosEntries(init.sysinfo.bios) },
				system: { entry: smbiosEntries({ ...init.sysinfo.system, uuid }) },
				baseBoard: { entry: smbiosEntries(init.sysinfo.baseBoard) },
				chassis: { entry: smbiosEntries(init.sysinfo.chassis) },
				oemStrings: { entry: init.sysinfo.oemStrings },
			},
			features: {
				acpi: '',
				apic: '',
				smm: { '@state': 'on' },
				kvm: { hidden: { '@state': 'on' } },
				vmport: { '@state': 'off' },
			},
			cpu: {
				'@mode': 'host-passthrough',
				'@check': 'none',
				'@migratable': 'off',
				topology: {
					'@sockets': 1,
					'@dies': 1,
					'@clusters': 1,
					'@cores': processors.length / threads,
					'@threads': threads,
				},
				feature: { '@policy': 'disable', '@name': 'hypervisor' },
				cache: { '@mode': 'passthrough' },
				maxphysaddr: { '@mode': 'passthrough' },
			},
			clock: {
				'@offset': 'localtime',
				timer: [
					{ '@name': 'rtc', '@tickpolicy': 'catchup' },
					{ '@name': 'pit', '@tickpolicy': 'delay' },
					{ '@name': 'hpet', '@present': 'no' },
				],
			},
			on_poweroff: 'destroy',
			on_reboot: 'restart',
			on_crash: 'destroy',
			pm: {
				'suspend-to-mem': { '@enabled': 'no' },
				'suspend-to-disk': { '@enabled': 'no' },
			},
			devices: {
				emulator: `/usr/bin/qemu-system-${machine()}`,
				disk: {
					'@type': 'file',
					'@device': 'disk',
					driver: { '@name': 'qemu', '@type': 'qcow2', '@cache': 'writeback' },
					source: { '@file': init.disk.path },
					target: { '@dev': 'sda', '@bus': 'sata' },
					alias: { '@name': 'ua-disk0' },
					address: { '@type': 'drive', '@controller': 0, '@bus': 0, '@target': 0, '@unit': 0 },
				},
				controller: [
					{ '@type': 'usb', '@index': 0, '@model': 'nec-xhci', '@ports': 15, address: pciAddress(3, 0) },
					{ '@type': 'sata', '@index': 0, address: pciAddress(0, 0x1f, 2) },
					{ '@type': 'pci', '@index': 0, '@model': 'pcie-root' },
					rootPort(1, 0),
					{
						'@type': 'pci',
						'@index': 2,
						'@model': 'pcie-to-pci-bridge',
						model: { '@name': 'pcie-pci-bridge' },
						address: pciAddress(1, 0),
					},
					rootPort(3, 1),
					rootPort(4, 2),
					rootPort(5, 3),
					rootPort(6, 4),
				],
				interface: {
					'@type': 'user',
					mac: { '@address': mac },
					model: { '@type': 'rtl8139' },
					address: pciAddress(2, 1),
				},
				serial: {
					'@type': 'pty',
					target: { '@type': 'isa-serial', '@port': 0, model: { '@name': 'isa-serial' } },
				},
				console: { '@type': 'pty', target: { '@type': 'serial', '@port': 0 } },
				input: [
					{ '@type': 'mouse', '@bus': 'ps2' },
					{ '@type': 'keyboard', '@bus': 'ps2' },
				],
				graphics: {
					'@type': 'spice',
					listen: { '@type': 'none' },
					image: { '@compression': 'off' },
					gl: { '@enable': 'no' },
				},
				sound: { '@model': 'ich9', address: pciAddress(0, 0x1b) },
				audio: { '@id': 1, '@type': 'spice' },
				video: {
					model: {
						'@type': 'vga',
						'@vram': 65536,
						'@heads': 1,
						'@primary': 'yes',
						resolution: { '@x': width, '@y': height },
					},
					address: pciAddress(0, 1),
				},
				watchdog: { '@model': 'itco', '@action': 'reset' },
				memballoon: { '@model': 'none' },
			},
			'qemu:override': {
				'qemu:device': {
					'@alias': 'ua-disk0',
					'qemu:frontend': {
						'qemu:property': [
							{ '@name': 'model', '@type': 'string', '@value': init.disk.model },
							{ '@name': 'serial', '@type': 'string', '@value': init.disk.serial },
						],
					},
				},
			},
			'qemu:commandline': {
				'qemu:arg': [
					'-smbios',
					smbiosOption(17, { ...init.memoryModule, loc_pfx: 'DIMM', bank: 'BANK' }),
					'-smbios',
					smbiosOption(4, {
						...(cpuManufacturer && { manufacturer: cpuManufacturer }),
						version: cpuModel,
						'max-speed': Math.max(...processors.map(cpu => cpu.speed)),
						'current-speed': Math.round(processors.reduce((total, cpu) => total + cpu.speed, 0) / processors.length),
					}),
				].map(value => ({ '@value': value })),
			},
		},
	});
}
