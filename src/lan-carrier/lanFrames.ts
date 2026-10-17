/**
 * The WebSocket wire format (RFC 6455), as much of it as the link needs.
 *
 * The Local Sync plugin uses the `ws` package. That package cannot be part of
 * the plugin bundle (its browser build refuses to run), so the framing is
 * written out here: frames with 7-, 16- and 64-bit lengths, client masking,
 * fragmented messages, ping, pong and close. It is pure and has no Node
 * dependency beyond `Buffer`, and is tested against the `ws` package.
 */

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class LanFrameError extends Error {
	constructor(message: string, readonly closeCode = 1002) {
		super(message);
		this.name = "LanFrameError";
	}
}

/** Build one frame. Clients must mask (`maskKey` given); servers must not. */
export function encodeFrame(opcode: number, payload: Uint8Array, maskKey?: Uint8Array): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeUInt32BE(Math.floor(length / 0x100000000), 2);
		header.writeUInt32BE(length >>> 0, 6);
	}
	if (!maskKey) return Buffer.concat([header, payload]);
	if (maskKey.length !== 4) throw new Error("mask key must be 4 bytes");
	header[1] = (header[1] ?? 0) | 0x80;
	const masked = Buffer.alloc(length);
	for (let i = 0; i < length; i++) masked[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
	return Buffer.concat([header, Buffer.from(maskKey), masked]);
}

export type LanFrameMessage =
	| { kind: "text"; data: string }
	| { kind: "binary"; data: Buffer }
	| { kind: "ping"; data: Buffer }
	| { kind: "pong"; data: Buffer }
	| { kind: "close"; code: number; reason: string };

/**
 * Turns the bytes read from a socket into messages. `expectMasked` is true on
 * the server side (clients always mask) and false on the client side.
 */
export class LanFrameParser {
	private buffer: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentOpcode = 0;
	private fragmentBytes = 0;

	constructor(
		private readonly expectMasked: boolean,
		private readonly maxMessageBytes: number,
	) {}

	push(chunk: Buffer): LanFrameMessage[] {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const out: LanFrameMessage[] = [];
		for (;;) {
			const parsed = this.readFrame();
			if (!parsed) break;
			const message = this.accept(parsed.fin, parsed.opcode, parsed.payload);
			if (message) out.push(message);
		}
		return out;
	}

	private readFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
		const buf = this.buffer;
		if (buf.length < 2) return null;
		const b0 = buf[0] ?? 0;
		const b1 = buf[1] ?? 0;
		if ((b0 & 0x70) !== 0) throw new LanFrameError("reserved bits set");
		const fin = (b0 & 0x80) !== 0;
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		if (masked !== this.expectMasked) throw new LanFrameError(masked ? "unexpected masked frame" : "frame is not masked");
		let length = b1 & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (buf.length < 4) return null;
			length = buf.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (buf.length < 10) return null;
			const high = buf.readUInt32BE(2);
			const low = buf.readUInt32BE(6);
			if (high > 0x1fffff) throw new LanFrameError("frame too large", 1009);
			length = high * 0x100000000 + low;
			offset = 10;
		}
		if (length > this.maxMessageBytes) throw new LanFrameError("message too large", 1009);
		const isControl = opcode >= 0x8;
		if (isControl && (length > 125 || !fin)) throw new LanFrameError("bad control frame");
		const maskLength = masked ? 4 : 0;
		if (buf.length < offset + maskLength + length) return null;
		const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
		const start = offset + maskLength;
		const payload = Buffer.from(buf.subarray(start, start + length));
		if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
		this.buffer = buf.subarray(start + length);
		return { fin, opcode, payload };
	}

	private accept(fin: boolean, opcode: number, payload: Buffer): LanFrameMessage | null {
		if (opcode === OP_PING) return { kind: "ping", data: payload };
		if (opcode === OP_PONG) return { kind: "pong", data: payload };
		if (opcode === OP_CLOSE) {
			const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
			return { kind: "close", code, reason: payload.length > 2 ? payload.subarray(2).toString("utf8") : "" };
		}
		if (opcode === OP_TEXT || opcode === OP_BINARY) {
			if (this.fragments.length > 0) throw new LanFrameError("new message inside a fragmented one");
			if (fin) return this.finish(opcode, payload);
			this.fragmentOpcode = opcode;
			this.fragments = [payload];
			this.fragmentBytes = payload.length;
			return null;
		}
		if (opcode === OP_CONTINUATION) {
			if (this.fragments.length === 0) throw new LanFrameError("continuation without a start");
			this.fragmentBytes += payload.length;
			if (this.fragmentBytes > this.maxMessageBytes) throw new LanFrameError("message too large", 1009);
			this.fragments.push(payload);
			if (!fin) return null;
			const whole = Buffer.concat(this.fragments);
			const startOpcode = this.fragmentOpcode;
			this.fragments = [];
			this.fragmentBytes = 0;
			return this.finish(startOpcode, whole);
		}
		throw new LanFrameError(`unknown opcode ${opcode}`);
	}

	private finish(opcode: number, payload: Buffer): LanFrameMessage {
		return opcode === OP_TEXT ? { kind: "text", data: payload.toString("utf8") } : { kind: "binary", data: payload };
	}
}

export function encodeClosePayload(code: number, reason = ""): Buffer {
	const reasonBytes = Buffer.from(reason.slice(0, 100), "utf8");
	const out = Buffer.alloc(2 + reasonBytes.length);
	out.writeUInt16BE(code, 0);
	reasonBytes.copy(out, 2);
	return out;
}
