import XMLBuilder from 'fast-xml-builder';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, machine, totalmem } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { data, name } from './data.js';
import { virsh } from './io.js';

/** The domain's state as virsh reports it, e.g. `running`, `paused` or `shut off` */
export function state(): string {
	return virsh(`Checking ${name()}`, 'domstate', name()).trim();
}

export function assertRunning(): void {
	const current = state();
	if (current != 'running')
		throw new Error(`Domain '${name()}' is not ${current == 'shut off' ? 'running' : `running (${current})`} on ${data.url}`);
}

/**
 * Start the domain, or resume it if it is paused. Does nothing if it is already running.
 * Returns whether the domain was powered on, as opposed to already running or resumed.
 */
export function start(): boolean {
	const current = state();
	if (current == 'running') return false;
	if (current == 'paused') {
		virsh(`Resuming ${name()}`, 'resume', name());
		return false;
	}
	virsh(`Starting ${name()}`, 'start', name());
	return true;
}

export interface StopOptions {
	/** Power off immediately instead of asking the guest to shut down */
	force?: boolean;
	/** Seconds to wait for the guest to shut down before powering it off */
	timeout?: number;
}

/** Ask the guest to shut down, and power it off if it has not within the timeout. */
export async function stop({ force = false, timeout = 60 }: StopOptions = {}): Promise<void> {
	if (state() == 'shut off') return;

	if (!force) {
		virsh(`Shutting down ${name()}`, 'shutdown', name());

		for (const deadline = Date.now() + timeout * 1000; Date.now() < deadline;) {
			await setTimeout(1000);
			if (state() == 'shut off') return;
		}
	}

	virsh(`Powering off ${name()}`, 'destroy', name());
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

export function createXML(init: DomainInit): string {
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
