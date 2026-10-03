/**
 * One WebSocket connection over TLS: the server side (accepting an upgrade)
 * and the client side (opening a connection and learning which certificate the
 * server presented).
 *
 * Modelled on the connection-manager of the Local Sync plugin (MIT, liuboacean),
 * which runs a WSS server and dials WSS clients with a self-signed certificate
 * that is checked by its fingerprint rather than by a certificate authority.
 */
import type * as Https from "https";
import type * as Net from "net";
import type * as Tls from "tls";
import type { IncomingMessage } from "http";
import {
	LanFrameError,
	LanFrameParser,
	OP_BINARY,
	OP_CLOSE,
	OP_PING,
	OP_PONG,
	OP_TEXT,
	WEBSOCKET_GUID,
	encodeClosePayload,
	encodeFrame,
	type LanFrameMessage,
} from "./lanFrames";
import { LAN_MAX_MESSAGE_BYTES } from "./lanConstants";
import { fingerprintOfDer } from "./lanCert";
import { loadLanNode } from "./lanNode";

export interface LanSocketHandlers {
	onText: (text: string) => void;
	onBinary: (data: Buffer) => void;
	onClose: (code: number, reason: string) => void;
	onPong?: () => void;
}

/** A framed, bidirectional connection. Created by `acceptLanUpgrade` or `connectLanSocket`. */
export class LanSocket {
	private handlers: LanSocketHandlers | null = null;
	private readonly parser: LanFrameParser;
	private closed = false;
	private closeSent = false;
	/** Bytes that arrived before the handlers were attached. */
	private early: Buffer[] = [];

	constructor(
		private readonly socket: Net.Socket,
		private readonly isClient: boolean,
		head: Buffer,
		maxMessageBytes = LAN_MAX_MESSAGE_BYTES,
	) {
		this.parser = new LanFrameParser(!isClient, maxMessageBytes);
		if (head.length > 0) this.early.push(head);
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", () => this.finish(1006, "socket error"));
		socket.on("close", () => this.finish(1006, "socket closed"));
		socket.on("end", () => this.finish(1006, "socket ended"));
		socket.setNoDelay(true);
	}

	get remoteAddress(): string {
		return this.socket.remoteAddress ?? "";
	}

	get isClosed(): boolean {
		return this.closed;
	}

	attach(handlers: LanSocketHandlers): void {
		this.handlers = handlers;
		const pending = this.early;
		this.early = [];
		for (const chunk of pending) this.onData(chunk);
	}

	sendText(text: string): void {
		this.write(OP_TEXT, Buffer.from(text, "utf8"));
	}

	sendBinary(data: Uint8Array): void {
		this.write(OP_BINARY, data);
	}

	ping(): void {
		this.write(OP_PING, Buffer.alloc(0));
	}

	close(code = 1000, reason = ""): void {
		if (this.closed) return;
		if (!this.closeSent) {
			this.closeSent = true;
			try {
				this.write(OP_CLOSE, encodeClosePayload(code, reason));
			} catch {
				// the socket is already gone
			}
		}
		// Give the peer a moment to read the close frame, then drop the connection.
		this.socket.end();
		window.setTimeout(() => this.socket.destroy(), 500);
		this.finish(code, reason);
	}

	/** Drop the connection without a close frame. */
	terminate(): void {
		this.socket.destroy();
		this.finish(1006, "terminated");
	}

	private write(opcode: number, payload: Uint8Array): void {
		if (this.closed && opcode !== OP_CLOSE) return;
		const mask = this.isClient ? loadLanNode().crypto.randomBytes(4) : undefined;
		this.socket.write(encodeFrame(opcode, payload, mask));
	}

	private onData(chunk: Buffer): void {
		if (!this.handlers) {
			this.early.push(chunk);
			return;
		}
		let messages: LanFrameMessage[];
		try {
			messages = this.parser.push(chunk);
		} catch (err) {
			const code = err instanceof LanFrameError ? err.closeCode : 1002;
			this.close(code, err instanceof Error ? err.message : "bad frame");
			return;
		}
		for (const message of messages) {
			if (this.closed) return;
			switch (message.kind) {
				case "text": this.handlers.onText(message.data); break;
				case "binary": this.handlers.onBinary(message.data); break;
				case "ping": this.write(OP_PONG, message.data); break;
				case "pong": this.handlers.onPong?.(); break;
				case "close":
					this.close(message.code === 1005 ? 1000 : message.code, message.reason);
					break;
			}
		}
	}

	private finish(code: number, reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.handlers?.onClose(code, reason);
	}
}

// ---------------------------------------------------------------------------
// Server side
// ---------------------------------------------------------------------------

/** Complete the WebSocket upgrade of an incoming request. Returns null (and closes the socket) when it is not a valid upgrade. */
export function acceptLanUpgrade(req: IncomingMessage, socket: Net.Socket, head: Buffer): LanSocket | null {
	const key = req.headers["sec-websocket-key"];
	const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
	if (typeof key !== "string" || upgrade !== "websocket" || req.headers["sec-websocket-version"] !== "13") {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return null;
	}
	const accept = loadLanNode().crypto.createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n"
		+ "Upgrade: websocket\r\n"
		+ "Connection: Upgrade\r\n"
		+ `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	return new LanSocket(socket, false, head);
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

export interface LanConnectOptions {
	host: string;
	port: number;
	timeoutMs: number;
}

export interface LanConnected {
	socket: LanSocket;
	/** Fingerprint of the certificate the server actually presented on this connection. */
	serverFingerprint: string;
}

/**
 * Open a secure WebSocket. The certificate is NOT checked against an authority
 * (it is self-signed); the caller gets the fingerprint of what was presented and
 * must bind its sign-in to it.
 */
export function connectLanSocket(options: LanConnectOptions): Promise<LanConnected> {
	const { https, crypto } = loadLanNode();
	return new Promise<LanConnected>((resolve, reject) => {
		let settled = false;
		const fail = (err: Error): void => {
			if (settled) return;
			settled = true;
			reject(err);
		};
		const key = crypto.randomBytes(16).toString("base64");
		const request: ReturnType<typeof Https.request> = https.request({
			host: options.host,
			port: options.port,
			path: "/yaos-lan",
			// A fresh agent per connection: no TLS session is ever resumed, because a resumed
			// session does not present the certificate again and the fingerprint must be seen every time.
			agent: false,
			method: "GET",
			// Self-signed: trust comes from the key-bound sign-in plus the pinned fingerprint, not from an authority.
			rejectUnauthorized: false,
			timeout: options.timeoutMs,
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": key,
			},
		});
		request.on("timeout", () => {
			request.destroy(new Error("connection timed out"));
		});
		request.on("error", (err: Error) => fail(err));
		request.on("response", (res: IncomingMessage) => {
			res.resume();
			fail(new Error(`the other device refused the connection (${res.statusCode ?? "?"})`));
			request.destroy();
		});
		request.on("upgrade", (res: IncomingMessage, socket: Net.Socket, head: Buffer) => {
			const expected = crypto.createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
			if (res.headers["sec-websocket-accept"] !== expected) {
				socket.destroy();
				fail(new Error("the other device did not answer like a YAOS device"));
				return;
			}
			const cert = (socket as Tls.TLSSocket).getPeerCertificate?.(false);
			if (!cert || !cert.raw) {
				socket.destroy();
				fail(new Error("the other device presented no certificate"));
				return;
			}
			socket.setTimeout(0);
			if (settled) {
				socket.destroy();
				return;
			}
			settled = true;
			resolve({ socket: new LanSocket(socket, true, head), serverFingerprint: fingerprintOfDer(cert.raw) });
		});
		request.end();
	});
}
