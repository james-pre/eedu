import * as io from 'ioium/node';
import { mkdtempDisposableSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { dataDir } from '../../data.js';
import { onAdd, prompt, select } from '../../discovery.js';
import { data, store } from './data.js';
import { assertRunning } from './domain.js';
import { tempPrefix, virsh } from './io.js';

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
