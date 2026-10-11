import sharp from 'sharp';

/** How the server packs each pixel, from its `ServerInit` */
interface PixelFormat {
	bits: number;
	bigEndian: boolean;
	trueColor: boolean;
	max: [number, number, number];
	shift: [number, number, number];
}

function pixelFormat(data: Buffer): PixelFormat {
	return {
		bits: data.readUInt8(0),
		bigEndian: !!data.readUInt8(2),
		trueColor: !!data.readUInt8(3),
		max: [data.readUInt16BE(4), data.readUInt16BE(6), data.readUInt16BE(8)],
		shift: [data.readUInt8(10), data.readUInt8(11), data.readUInt8(12)],
	};
}

/** Buffers incoming data so messages can be read by size */
class Stream {
	#data: Buffer = Buffer.alloc(0);
	#wanted?: { size: number; resolve(data: Buffer): void };
	#failure?: Error;
	#reject?: (error: Error) => void;

	push(data: Buffer): void {
		this.#data = Buffer.concat([this.#data, data]);
		if (!this.#wanted || this.#data.length < this.#wanted.size) return;
		const { size, resolve } = this.#wanted;
		this.#wanted = undefined;
		this.#reject = undefined;
		const taken = this.#data.subarray(0, size);
		this.#data = this.#data.subarray(size);
		resolve(taken);
	}

	fail(error: Error): void {
		this.#failure = error;
		this.#reject?.(error);
	}

	read(size: number): Promise<Buffer> {
		if (this.#failure) return Promise.reject(this.#failure);
		const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
		this.#wanted = { size, resolve };
		this.#reject = reject;
		this.push(Buffer.alloc(0));
		return promise;
	}
}

const keysyms: Record<string, number> = {
	backspace: 0xff08,
	tab: 0xff09,
	enter: 0xff0d,
	return: 0xff0d,
	escape: 0xff1b,
	esc: 0xff1b,
	space: 0x20,
	insert: 0xff63,
	delete: 0xffff,
	home: 0xff50,
	end: 0xff57,
	pageup: 0xff55,
	pagedown: 0xff56,
	left: 0xff51,
	up: 0xff52,
	right: 0xff53,
	down: 0xff54,
	shift: 0xffe1,
	ctrl: 0xffe3,
	control: 0xffe3,
	alt: 0xffe9,
	super: 0xffeb,
	win: 0xffeb,
	capslock: 0xffe5,
};

for (let n = 1; n <= 12; n++) keysyms['f' + n] = 0xffbd + n;

/** Characters typed with shift held on a US layout */
const shifted = '~!@#$%^&*()_+{}|:"<>?';

function keysym(key: string): number {
	const named = keysyms[key.toLowerCase()];
	if (named !== undefined) return named;
	if ([...key].length == 1) return key.codePointAt(0)!;
	throw new Error('Unknown key: ' + key);
}

/** Mouse buttons as their bit in a pointer event's mask */
const buttons = { left: 1, middle: 2, right: 4, up: 8, down: 16 };

export type Button = keyof typeof buttons;

/** The websocket URL behind a noVNC page URL, which carries the host and path as query parameters */
export function socketUrl(url: string): string {
	const { searchParams } = new URL(url);
	const host = searchParams.get('host');
	const port = searchParams.get('port');
	const path = searchParams.get('path');
	if (!host || !path) throw new Error('Not a noVNC URL: ' + url);
	return `wss://${host}${port ? ':' + port : ''}/${path}`;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * A VNC client that can see the screen and use the keyboard and mouse.
 * Only the raw encoding is used, so every update carries whole pixels.
 */
export class Screen implements Disposable {
	#socket: WebSocket;
	#stream = new Stream();
	#format!: PixelFormat;
	/** Pixels in the server's format, one screen's worth */
	#pixels!: Buffer;
	#updated?: () => void;

	readonly width!: number;
	readonly height!: number;
	readonly name!: string;

	private constructor(socket: WebSocket) {
		this.#socket = socket;
	}

	/** Connect to a VNC server and finish the handshake. `url` is a websocket or noVNC page URL. */
	static async connect(url: string, timeout: number = 30_000): Promise<Screen> {
		const socket = new WebSocket(url.startsWith('ws') ? url : socketUrl(url));
		socket.binaryType = 'arraybuffer';
		const screen = new Screen(socket);

		socket.onmessage = event => screen.#stream.push(Buffer.from(event.data as ArrayBuffer));
		socket.onclose = () => screen.#stream.fail(new Error('The VNC connection closed'));
		socket.onerror = () => screen.#stream.fail(new Error('The VNC connection failed'));

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		socket.onopen = () => resolve();
		const timer = setTimeout(() => reject(new Error(`The VNC server did not respond within ${timeout / 1000}s`)), timeout);
		try {
			await promise;
			await screen.#handshake();
		} finally {
			clearTimeout(timer);
		}

		return screen;
	}

	async #handshake(): Promise<void> {
		const version = String(await this.#stream.read(12));
		if (!version.startsWith('RFB ')) throw new Error('Not a VNC server');
		this.#send(Buffer.from('RFB 003.008\n'));

		const count = (await this.#stream.read(1))[0];
		if (!count) {
			const length = (await this.#stream.read(4)).readUInt32BE(0);
			throw new Error('VNC connection refused: ' + String(await this.#stream.read(length)));
		}

		const types = [...(await this.#stream.read(count))];
		if (!types.includes(1)) throw new Error('The VNC server wants a password');
		this.#send(Buffer.from([1]));

		const result = (await this.#stream.read(4)).readUInt32BE(0);
		if (result) throw new Error('The VNC server rejected the connection');

		// Share the session rather than disconnecting anyone else on it.
		this.#send(Buffer.from([1]));

		const init = await this.#stream.read(24);
		Object.assign(this, { width: init.readUInt16BE(0), height: init.readUInt16BE(2) });
		this.#format = pixelFormat(init.subarray(4, 20));
		if (!this.#format.trueColor) throw new Error('The VNC server uses a color map');
		if (this.#format.bits % 8) throw new Error(`${this.#format.bits}-bit pixels are not supported`);
		Object.assign(this, { name: String(await this.#stream.read(init.readUInt32BE(20))) });

		this.#pixels = Buffer.alloc(this.width * this.height * (this.#format.bits / 8));

		const encodings = Buffer.alloc(8);
		encodings.writeUInt8(2, 0);
		encodings.writeUInt16BE(1, 2);
		encodings.writeInt32BE(0, 4);
		this.#send(encodings);

		void this.#receive();
	}

	#send(data: Buffer): void {
		this.#socket.send(new Uint8Array(data));
	}

	/** Read server messages until the connection closes, keeping the pixels up to date */
	async #receive(): Promise<void> {
		try {
			for (;;) {
				const [type] = await this.#stream.read(1);
				switch (type) {
					case 0:
						await this.#applyUpdate();
						this.#updated?.();
						break;
					case 1: {
						const header = await this.#stream.read(5);
						await this.#stream.read(header.readUInt16BE(3) * 6);
						break;
					}
					case 2:
						break;
					case 3: {
						await this.#stream.read(3);
						await this.#stream.read((await this.#stream.read(4)).readUInt32BE(0));
						break;
					}
					default:
						throw new Error('Unexpected VNC message: ' + type);
				}
			}
		} catch {
			// The connection closed or went wrong, which anything waiting on it will see.
		}
	}

	async #applyUpdate(): Promise<void> {
		const header = await this.#stream.read(3);
		const bytes = this.#format.bits / 8;

		for (let i = 0; i < header.readUInt16BE(1); i++) {
			const rect = await this.#stream.read(12);
			const [x, y, width, height] = [rect.readUInt16BE(0), rect.readUInt16BE(2), rect.readUInt16BE(4), rect.readUInt16BE(6)];
			const encoding = rect.readInt32BE(8);
			if (encoding != 0) throw new Error('Unsupported VNC encoding: ' + encoding);

			const data = await this.#stream.read(width * height * bytes);
			for (let row = 0; row < height; row++)
				data.copy(this.#pixels, ((y + row) * this.width + x) * bytes, row * width * bytes, (row + 1) * width * bytes);
		}
	}

	/** Ask for the whole screen and wait for it to arrive */
	async #refresh(timeout: number = 20_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#updated = resolve;
		const timer = setTimeout(() => reject(new Error('The VNC server did not send the screen in time')), timeout);

		const request = Buffer.alloc(10);
		request.writeUInt8(3, 0);
		request.writeUInt16BE(this.width, 6);
		request.writeUInt16BE(this.height, 8);
		this.#send(request);

		try {
			await promise;
		} finally {
			clearTimeout(timer);
			this.#updated = undefined;
		}
	}

	/** The screen as a PNG */
	async capture(): Promise<Buffer> {
		await this.#refresh();

		const { bits, bigEndian, max, shift } = this.#format;
		const bytes = bits / 8;
		const rgb = Buffer.alloc(this.width * this.height * 3);

		for (let i = 0; i < this.width * this.height; i++) {
			const pixel =
				bytes == 4
					? bigEndian
						? this.#pixels.readUInt32BE(i * 4)
						: this.#pixels.readUInt32LE(i * 4)
					: bigEndian
						? this.#pixels.readUIntBE(i * bytes, bytes)
						: this.#pixels.readUIntLE(i * bytes, bytes);
			for (let channel = 0; channel < 3; channel++)
				rgb[i * 3 + channel] = Math.round((((pixel >>> shift[channel]) & max[channel]) * 255) / max[channel]);
		}

		return await sharp(rgb, { raw: { width: this.width, height: this.height, channels: 3 } })
			.png()
			.toBuffer();
	}

	#key(sym: number, down: boolean): void {
		const event = Buffer.alloc(8);
		event.writeUInt8(4, 0);
		event.writeUInt8(down ? 1 : 0, 1);
		event.writeUInt32BE(sym, 4);
		this.#send(event);
	}

	/** Press and release keys together, e.g. `ctrl+alt+delete` or `Enter` */
	async press(chord: string, delay: number = 40): Promise<void> {
		const syms = chord.split('+').map(key => keysym(key.trim()));
		for (const sym of syms) this.#key(sym, true);
		await sleep(delay);
		for (const sym of syms.reverse()) this.#key(sym, false);
		await sleep(delay);
	}

	/** Type text one character at a time, with `\n` pressing Enter */
	async type(text: string, delay: number = 20): Promise<void> {
		for (const character of text) {
			if (character == '\n') {
				await this.press('Enter', delay);
				continue;
			}

			const shift = shifted.includes(character) || (character != character.toLowerCase() && character == character.toUpperCase());
			if (shift) this.#key(keysyms.shift, true);
			this.#key(keysym(character), true);
			await sleep(delay);
			this.#key(keysym(character), false);
			if (shift) this.#key(keysyms.shift, false);
			await sleep(delay);
		}
	}

	#pointer(x: number, y: number, mask: number): void {
		const event = Buffer.alloc(6);
		event.writeUInt8(5, 0);
		event.writeUInt8(mask, 1);
		event.writeUInt16BE(Math.round(x), 2);
		event.writeUInt16BE(Math.round(y), 4);
		this.#send(event);
	}

	async move(x: number, y: number): Promise<void> {
		this.#pointer(x, y, 0);
		await sleep(40);
	}

	async click(x: number, y: number, button: Button = 'left', count: number = 1): Promise<void> {
		for (let i = 0; i < count; i++) {
			this.#pointer(x, y, buttons[button]);
			await sleep(40);
			this.#pointer(x, y, 0);
			await sleep(i + 1 < count ? 80 : 40);
		}
	}

	/** Scroll at a point, which is a press and release of a wheel button */
	async scroll(x: number, y: number, direction: 'up' | 'down', count: number = 3): Promise<void> {
		await this.click(x, y, direction, count);
	}

	/** Put text on the server's clipboard, for pasting instead of typing */
	paste(text: string): void {
		const data = Buffer.from(text, 'latin1');
		const message = Buffer.alloc(8 + data.length);
		message.writeUInt8(6, 0);
		message.writeUInt32BE(data.length, 4);
		data.copy(message, 8);
		this.#send(message);
	}

	close(): void {
		this.#socket.close();
	}

	[Symbol.dispose](): void {
		this.close();
	}
}
