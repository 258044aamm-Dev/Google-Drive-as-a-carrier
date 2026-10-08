/**
 * The link layer of the Local network carrier: a secure WebSocket server, the
 * dialer that connects to other devices, the key-bound sign-in, and the
 * discovery of devices on the network.
 *
 * It follows the design of the Local Sync plugin's connection-manager (MIT,
 * liuboacean): every device is server and client at once ("duplex"); a link is
 * WSS over a self-signed ECDSA certificate; the shared key authenticates the
 * link; reconnects back off from 1 s to 60 s; a ping every 120 s detects dead
 * links. See `lanAuth.ts` for how sign-in differs from the original.
 *
 * The hub moves bytes and knows nothing about Yjs: `LanTransport` sits on top.
 */
import type * as Https from "https";
import type { IncomingMessage } from "http";
import type * as Net from "net";
import {
	LAN_HANDSHAKE_TIMEOUT_MS,
	LAN_HEARTBEAT_INTERVAL_MS,
	LAN_HEARTBEAT_TIMEOUT_MS,
	LAN_PROTOCOL_VERSION,
	LAN_RECONNECT_BASE_MS,
	LAN_RECONNECT_MAX_MS,
} from "./lanConstants";
import { LanLockout, computeProof, isAcceptableLanKey, randomNonce, verifyProof } from "./lanAuth";
import { LanDiscovery, vaultTag, type LanDiscoveredDevice } from "./lanDiscovery";
import { encodeLanText, lanHello, parseLanText, type LanTextMessage } from "./lanProtocol";
import { LanSocket, acceptLanUpgrade, connectLanSocket } from "./lanSocket";
import { loadLanNode } from "./lanNode";

export interface LanHubCert {
	certPem: string;
	keyPem: string;
	fingerprint: string;
}

export interface LanLinkHandlers {
	onText: (message: LanTextMessage) => void;
	onBinary: (data: Uint8Array) => void;
	onClose: (reason: string) => void;
}

/** One signed-in connection to another device. */
export class LanLink {
	private handlers: LanLinkHandlers | null = null;
	private closed = false;
	private lastHeardAt: number;
	private heartbeat: number | null = null;
	/** Messages that arrived before a handler was set. */
	private earlyText: LanTextMessage[] = [];
	private earlyBinary: Uint8Array[] = [];

	constructor(
		readonly deviceId: string,
		readonly deviceName: string,
		readonly address: string,
		readonly direction: "in" | "out",
		readonly fingerprint: string,
		private readonly socket: LanSocket,
		private readonly now: () => number,
		private readonly onClosed: (link: LanLink, reason: string) => void,
		heartbeatMs: number,
		timeoutMs: number,
	) {
		this.lastHeardAt = now();
		this.heartbeat = window.setInterval(() => {
			if (this.closed) return;
			if (this.now() - this.lastHeardAt > timeoutMs) {
				this.close("the other device stopped answering");
				return;
			}
			this.socket.ping();
		}, heartbeatMs);
	}

	setHandlers(handlers: LanLinkHandlers): void {
		this.handlers = handlers;
		const text = this.earlyText;
		const binary = this.earlyBinary;
		this.earlyText = [];
		this.earlyBinary = [];
		for (const m of text) handlers.onText(m);
		for (const b of binary) handlers.onBinary(b);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	sendText(message: LanTextMessage): void {
		if (this.closed) return;
		this.socket.sendText(encodeLanText(message));
	}

	sendBinary(data: Uint8Array): void {
		if (this.closed) return;
		this.socket.sendBinary(data);
	}

	close(reason = "closed"): void {
		this.finish(reason);
		this.socket.close(1000, reason.slice(0, 100));
	}

	/** Used by the hub when it wires the socket's messages in. */
	deliverText(message: LanTextMessage): void {
		this.lastHeardAt = this.now();
		if (this.handlers) this.handlers.onText(message);
		else this.earlyText.push(message);
	}

	deliverBinary(data: Uint8Array): void {
		this.lastHeardAt = this.now();
		if (this.handlers) this.handlers.onBinary(data);
		else this.earlyBinary.push(data);
	}

	markHeard(): void {
		this.lastHeardAt = this.now();
	}

	finish(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
		this.heartbeat = null;
		this.handlers?.onClose(reason);
		this.onClosed(this, reason);
	}
}

export interface LanHubOptions {
	deviceId: string;
	deviceName: string;
	vaultId: string;
	/** The shared key. A missing or short key stops the hub from starting. */
	key: string;
	/** TCP port of the server. 0 = any free port (tests). */
	port: number;
	discoveryPort: number;
	discoveryEnabled: boolean;
	/** `host:port` entries the user typed in, dialled in addition to discovered devices. */
	manualPeers: string[];
	cert: LanHubCert;
	getPin: (deviceId: string) => string | undefined;
	setPin: (deviceId: string, fingerprint: string) => void;
	onLinkReady: (link: LanLink) => void;
	onStatusChanged?: () => void;
	log?: (message: string) => void;
	now?: () => number;
	/** Test hooks. */
	discoveryTargets?: Array<{ address: string; port: number }>;
	acceptAddress?: (address: string) => boolean;
	canAnnounce?: () => boolean;
	/** The device with the larger id waits this long before dialling a discovered device. */
	dialDelayMs?: number;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
	handshakeTimeoutMs?: number;
	heartbeatMs?: number;
	heartbeatTimeoutMs?: number;
	connectTimeoutMs?: number;
}

export interface LanRefusal {
	at: number;
	who: string;
	reason: string;
}

export interface LanHubStatus {
	listening: boolean;
	port: number | null;
	error: string | null;
	discoveryRunning: boolean;
	fingerprint: string;
	devices: LanDiscoveredDevice[];
	links: Array<{ deviceId: string; deviceName: string; address: string; direction: "in" | "out" }>;
	refusals: LanRefusal[];
}

interface DialTarget {
	key: string;
	host: string;
	port: number;
	deviceId: string | null;
	manual: boolean;
	failures: number;
	nextAt: number;
	dialing: boolean;
}

const MAX_PENDING_SOCKETS = 20;

export class LanHub {
	private server: Https.Server | null = null;
	private discovery: LanDiscovery | null = null;
	private listeningPort: number | null = null;
	private startError: string | null = null;
	private stopped = true;
	private readonly activeLinks = new Map<string, LanLink>();
	private readonly targets = new Map<string, DialTarget>();
	private readonly pendingSockets = new Set<LanSocket>();
	private readonly refusals: LanRefusal[] = [];
	private readonly lockout: LanLockout;
	private dialTimer: number | null = null;
	private readonly now: () => number;
	private readonly tag: string;
	private manual: string[];

	constructor(private readonly options: LanHubOptions) {
		this.now = options.now ?? (() => Date.now());
		this.lockout = new LanLockout(undefined, undefined, this.now);
		this.tag = vaultTag(options.vaultId);
		this.manual = [...options.manualPeers];
	}

	// -----------------------------------------------------------------------
	// Life cycle
	// -----------------------------------------------------------------------

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		this.startError = null;
		if (!isAcceptableLanKey(this.options.key)) {
			this.startError = "No pairing key is set. Create or paste one in the YAOS settings.";
			this.changed();
			return;
		}
		await this.startServer();
		if (this.stopped) return;
		if (this.options.discoveryEnabled) {
			this.discovery = new LanDiscovery({
				deviceId: this.options.deviceId,
				deviceName: this.options.deviceName,
				vault: this.tag,
				syncPort: this.listeningPort ?? this.options.port,
				discoveryPort: this.options.discoveryPort,
				targets: this.options.discoveryTargets,
				acceptAddress: this.options.acceptAddress,
				canAnnounce: () => this.listeningPort !== null && (this.options.canAnnounce ? this.options.canAnnounce() : true),
				onFound: (device) => this.onDeviceFound(device),
				onLost: (device) => this.onDeviceLost(device),
				log: (message) => this.log(message),
			});
			await this.discovery.start();
		}
		this.setManualPeers(this.manual);
		this.dialTimer = window.setInterval(() => this.dialDue(), 500);
		this.changed();
	}

	stop(): void {
		this.stopped = true;
		if (this.dialTimer !== null) window.clearInterval(this.dialTimer);
		this.dialTimer = null;
		this.discovery?.stop();
		this.discovery = null;
		for (const link of Array.from(this.activeLinks.values())) link.close("stopped");
		this.activeLinks.clear();
		for (const socket of Array.from(this.pendingSockets)) socket.terminate();
		this.pendingSockets.clear();
		this.targets.clear();
		try {
			this.server?.close();
		} catch {
			// not listening
		}
		this.server = null;
		this.listeningPort = null;
		this.changed();
	}

	private log(message: string): void {
		this.options.log?.(`lan: ${message}`);
	}

	private changed(): void {
		this.options.onStatusChanged?.();
	}

	status(): LanHubStatus {
		return {
			listening: this.listeningPort !== null,
			port: this.listeningPort,
			error: this.startError,
			discoveryRunning: this.discovery?.isRunning ?? false,
			fingerprint: this.options.cert.fingerprint,
			devices: this.discovery?.devices() ?? [],
			links: Array.from(this.activeLinks.values()).map((l) => ({
				deviceId: l.deviceId,
				deviceName: l.deviceName,
				address: l.address,
				direction: l.direction,
			})),
			refusals: [...this.refusals],
		};
	}

	links(): LanLink[] {
		return Array.from(this.activeLinks.values());
	}

	private refuse(who: string, reason: string): void {
		this.refusals.unshift({ at: this.now(), who, reason });
		if (this.refusals.length > 5) this.refusals.length = 5;
		this.log(`refused ${who}: ${reason}`);
		this.changed();
	}

	// -----------------------------------------------------------------------
	// Server side
	// -----------------------------------------------------------------------

	private startServer(): Promise<void> {
		const { https } = loadLanNode();
		return new Promise<void>((resolve) => {
			const server = https.createServer({
				key: this.options.cert.keyPem,
				cert: this.options.cert.certPem,
				minVersion: "TLSv1.2",
			}, (_req, res) => {
				res.writeHead(426, { "Content-Type": "text/plain" });
				res.end("YAOS Local network\n");
			});
			this.server = server;
			server.on("upgrade", (req: IncomingMessage, socket: Net.Socket, head: Buffer) => this.onUpgrade(req, socket, head));
			server.on("tlsClientError", () => undefined);
			server.on("error", (err: NodeJS.ErrnoException) => {
				this.startError = err.code === "EADDRINUSE"
					? `Port ${this.options.port} is already in use. Pick another port in the YAOS settings.`
					: `The link server could not start: ${err.message}`;
				this.log(this.startError);
				this.server = null;
				this.changed();
				resolve();
			});
			server.listen(this.options.port, () => {
				const address = server.address();
				this.listeningPort = typeof address === "object" && address ? address.port : this.options.port;
				this.log(`listening on port ${this.listeningPort}`);
				resolve();
			});
		});
	}

	private onUpgrade(req: IncomingMessage, rawSocket: Net.Socket, head: Buffer): void {
		const address = rawSocket.remoteAddress ?? "";
		if (this.stopped || this.lockout.isLocked(address) || this.pendingSockets.size >= MAX_PENDING_SOCKETS) {
			rawSocket.destroy();
			return;
		}
		const socket = acceptLanUpgrade(req, rawSocket, head);
		if (!socket) return;
		this.pendingSockets.add(socket);

		let state: "hello" | "auth" | "done" = "hello";
		let peer: { deviceId: string; deviceName: string; nonceC: string } | null = null;
		let nonceS = "";
		const ownFp = this.options.cert.fingerprint;
		const timer = window.setTimeout(() => {
			if (state !== "done") {
				this.log(`sign-in from ${address} timed out`);
				socket.terminate();
			}
		}, this.options.handshakeTimeoutMs ?? LAN_HANDSHAKE_TIMEOUT_MS);
		const sendRefuse = (reason: string): void => {
			try {
				socket.sendText(encodeLanText({ t: "refuse", reason }));
			} catch {
				// gone already
			}
			socket.close(1008, reason);
		};
		const heartbeatMs = this.options.heartbeatMs ?? LAN_HEARTBEAT_INTERVAL_MS;
		const heartbeatTimeoutMs = this.options.heartbeatTimeoutMs ?? LAN_HEARTBEAT_TIMEOUT_MS;
		let link: LanLink | null = null;

		socket.attach({
			onText: (text) => {
				const message = parseLanText(text);
				if (!message) {
					sendRefuse("unreadable message");
					return;
				}
				if (state === "hello") {
					if (message.t !== "hello") {
						sendRefuse("expected hello");
						return;
					}
					if (message.v !== LAN_PROTOCOL_VERSION) {
						this.refuse(message.deviceName, `different protocol version (${message.v})`);
						sendRefuse("different protocol version");
						return;
					}
					if (message.vault !== this.tag) {
						this.refuse(message.deviceName, "a different vault");
						sendRefuse("a different vault");
						return;
					}
					if (message.deviceId === this.options.deviceId) {
						sendRefuse("that is this device");
						return;
					}
					peer = { deviceId: message.deviceId, deviceName: message.deviceName, nonceC: message.nonce };
					nonceS = randomNonce();
					socket.sendText(encodeLanText({
						t: "challenge",
						v: LAN_PROTOCOL_VERSION,
						deviceId: this.options.deviceId,
						deviceName: this.options.deviceName,
						nonce: nonceS,
						proof: computeProof(this.options.key, "server", nonceS, message.nonce, ownFp),
					}));
					state = "auth";
					return;
				}
				if (state === "auth") {
					if (message.t !== "auth" || !peer) {
						sendRefuse("expected sign-in");
						return;
					}
					if (!verifyProof(this.options.key, "client", peer.nonceC, nonceS, ownFp, message.proof)) {
						this.lockout.recordFailure(address);
						this.refuse(peer.deviceName, "wrong key");
						if (this.lockout.isLocked(address)) this.refuse(address, "too many wrong keys: this address is locked out for a while");
						sendRefuse("wrong key");
						return;
					}
					this.lockout.recordSuccess(address);
					state = "done";
					window.clearTimeout(timer);
					this.pendingSockets.delete(socket);
					link = this.makeLink(peer.deviceId, peer.deviceName, address, "in", "", socket, heartbeatMs, heartbeatTimeoutMs);
					socket.sendText(encodeLanText({ t: "ready" }));
					this.register(link);
					return;
				}
				if (link) link.deliverText(message);
			},
			onBinary: (data) => {
				if (state === "done" && link) link.deliverBinary(data);
				else sendRefuse("not signed in");
			},
			onClose: (_code, reason) => {
				window.clearTimeout(timer);
				this.pendingSockets.delete(socket);
				link?.finish(reason || "closed");
			},
			onPong: () => link?.markHeard(),
		});
	}

	// -----------------------------------------------------------------------
	// Client side
	// -----------------------------------------------------------------------

	private async dial(target: DialTarget): Promise<void> {
		target.dialing = true;
		const label = `${target.host}:${target.port}`;
		try {
			const { socket, serverFingerprint } = await connectLanSocket({
				host: target.host,
				port: target.port,
				timeoutMs: this.options.connectTimeoutMs ?? 8000,
			});
			const link = await this.signInAsClient(socket, serverFingerprint, label);
			target.failures = 0;
			if (link) {
				target.deviceId = link.deviceId;
				this.register(link);
			}
		} catch (err) {
			target.failures++;
			this.log(`could not connect to ${label}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			target.dialing = false;
			const wait = Math.min(
				(this.options.reconnectBaseMs ?? LAN_RECONNECT_BASE_MS) * Math.pow(2, Math.min(target.failures, 10)),
				this.options.reconnectMaxMs ?? LAN_RECONNECT_MAX_MS,
			);
			target.nextAt = this.now() + wait;
		}
	}

	private signInAsClient(socket: LanSocket, serverFp: string, label: string): Promise<LanLink | null> {
		return new Promise<LanLink | null>((resolve) => {
			const nonceC = randomNonce();
			let state: "challenge" | "ready" | "done" = "challenge";
			let server: { deviceId: string; deviceName: string } | null = null;
			let link: LanLink | null = null;
			const heartbeatMs = this.options.heartbeatMs ?? LAN_HEARTBEAT_INTERVAL_MS;
			const heartbeatTimeoutMs = this.options.heartbeatTimeoutMs ?? LAN_HEARTBEAT_TIMEOUT_MS;
			const finishWith = (result: LanLink | null, why?: string): void => {
				window.clearTimeout(timer);
				if (!result && state !== "done") {
					if (why) this.refuse(server?.deviceName ?? label, why);
					socket.close(1008, why ?? "closed");
				}
				resolve(result);
			};
			const timer = window.setTimeout(() => {
				if (state !== "done") {
					socket.terminate();
					finishWith(null, "the other device did not finish signing in");
				}
			}, this.options.handshakeTimeoutMs ?? LAN_HANDSHAKE_TIMEOUT_MS);

			socket.attach({
				onText: (text) => {
					const message = parseLanText(text);
					if (!message) {
						finishWith(null, "unreadable message");
						return;
					}
					if (message.t === "refuse") {
						finishWith(null, `the other device refused: ${message.reason}`);
						return;
					}
					if (state === "challenge") {
						if (message.t !== "challenge" || message.v !== LAN_PROTOCOL_VERSION) {
							finishWith(null, "unexpected answer");
							return;
						}
						if (message.deviceId === this.options.deviceId) {
							finishWith(null, "that is this device");
							return;
						}
						server = { deviceId: message.deviceId, deviceName: message.deviceName };
						// The server's proof covers the certificate WE see; a middleman with another certificate fails here.
						if (!verifyProof(this.options.key, "server", message.nonce, nonceC, serverFp, message.proof)) {
							finishWith(null, "the other device does not know this key, or its connection was tampered with");
							return;
						}
						const pinned = this.options.getPin(message.deviceId);
						if (pinned && pinned !== serverFp) {
							finishWith(null, `${message.deviceName} presented a different certificate than before. If you reinstalled it, forget its pin in the settings.`);
							return;
						}
						socket.sendText(encodeLanText({ t: "auth", proof: computeProof(this.options.key, "client", nonceC, message.nonce, serverFp) }));
						state = "ready";
						return;
					}
					if (state === "ready") {
						if (message.t !== "ready" || !server) {
							finishWith(null, "unexpected answer");
							return;
						}
						state = "done";
						if (this.options.getPin(server.deviceId) !== serverFp) this.options.setPin(server.deviceId, serverFp);
						link = this.makeLink(server.deviceId, server.deviceName, label, "out", serverFp, socket, heartbeatMs, heartbeatTimeoutMs);
						finishWith(link);
						return;
					}
					link?.deliverText(message);
				},
				onBinary: (data) => {
					if (state === "done" && link) link.deliverBinary(data);
				},
				onClose: (_code, reason) => {
					if (state !== "done") finishWith(null, reason || "closed during sign-in");
					else link?.finish(reason || "closed");
				},
				onPong: () => link?.markHeard(),
			});
			socket.sendText(encodeLanText(lanHello(this.options.deviceId, this.options.deviceName, this.tag, nonceC)));
		});
	}

	// -----------------------------------------------------------------------
	// Links
	// -----------------------------------------------------------------------

	private makeLink(
		deviceId: string,
		deviceName: string,
		address: string,
		direction: "in" | "out",
		fingerprint: string,
		socket: LanSocket,
		heartbeatMs: number,
		timeoutMs: number,
	): LanLink {
		return new LanLink(deviceId, deviceName, address, direction, fingerprint, socket, this.now, (l, reason) => this.onLinkClosed(l, reason), heartbeatMs, timeoutMs);
	}

	/**
	 * Two devices may dial each other at the same moment. Both ends apply the
	 * same rule, so they agree which of the two links survives: the one opened by
	 * the device with the smaller id.
	 */
	private register(link: LanLink): void {
		if (this.stopped) {
			link.close("stopped");
			return;
		}
		const existing = this.activeLinks.get(link.deviceId);
		if (existing && !existing.isClosed) {
			const openerOf = (l: LanLink): string => (l.direction === "out" ? this.options.deviceId : l.deviceId);
			const keepNew = openerOf(link) <= openerOf(existing);
			if (!keepNew) {
				link.close("duplicate link");
				return;
			}
			this.activeLinks.delete(link.deviceId);
			existing.close("replaced by a newer link");
		}
		this.activeLinks.set(link.deviceId, link);
		this.log(`linked with ${link.deviceName} (${link.address}, ${link.direction === "out" ? "outgoing" : "incoming"})`);
		this.changed();
		this.options.onLinkReady(link);
	}

	private onLinkClosed(link: LanLink, reason: string): void {
		if (this.activeLinks.get(link.deviceId) === link) {
			this.activeLinks.delete(link.deviceId);
			this.log(`link with ${link.deviceName} closed: ${reason}`);
			// Try again soon: a restart or a Wi-Fi blip should heal by itself.
			for (const target of this.targets.values()) {
				if (target.deviceId === link.deviceId) target.nextAt = Math.min(target.nextAt, this.now() + (this.options.reconnectBaseMs ?? LAN_RECONNECT_BASE_MS));
			}
		}
		this.changed();
	}

	// -----------------------------------------------------------------------
	// Who to dial
	// -----------------------------------------------------------------------

	private onDeviceFound(device: LanDiscoveredDevice): void {
		const key = `id:${device.deviceId}`;
		const existing = this.targets.get(key);
		const delay = device.deviceId > this.options.deviceId ? (this.options.dialDelayMs ?? 2000) : 0;
		if (existing) {
			existing.host = device.address;
			existing.port = device.port;
			existing.failures = 0;
			existing.nextAt = Math.min(existing.nextAt, this.now() + delay);
		} else {
			this.targets.set(key, {
				key,
				host: device.address,
				port: device.port,
				deviceId: device.deviceId,
				manual: false,
				failures: 0,
				nextAt: this.now() + delay,
				dialing: false,
			});
		}
		this.changed();
	}

	private onDeviceLost(device: LanDiscoveredDevice): void {
		this.targets.delete(`id:${device.deviceId}`);
		this.changed();
	}

	/** Replace the list of typed-in addresses (`host:port`). */
	setManualPeers(peers: string[]): void {
		this.manual = [...peers];
		for (const key of Array.from(this.targets.keys())) {
			if (key.startsWith("addr:")) this.targets.delete(key);
		}
		for (const entry of peers) {
			const parsed = parseHostPort(entry);
			if (!parsed) continue;
			const key = `addr:${parsed.host}:${parsed.port}`;
			this.targets.set(key, { key, host: parsed.host, port: parsed.port, deviceId: null, manual: true, failures: 0, nextAt: this.now(), dialing: false });
		}
	}

	private dialDue(): void {
		if (this.stopped) return;
		const now = this.now();
		for (const target of this.targets.values()) {
			if (target.dialing || target.nextAt > now) continue;
			if (target.deviceId && this.activeLinks.has(target.deviceId)) {
				// Already linked; look again later in case the link drops.
				target.nextAt = now + 1000;
				continue;
			}
			if (this.isSelf(target)) continue;
			void this.dial(target);
		}
	}

	private isSelf(target: DialTarget): boolean {
		return target.deviceId === this.options.deviceId;
	}
}

/** Parse `host:port` (port optional is NOT allowed: it must be explicit). */
export function parseHostPort(entry: string): { host: string; port: number } | null {
	const trimmed = entry.trim();
	const match = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(trimmed);
	if (!match) return null;
	const port = Number(match[2]);
	if (port < 1 || port > 65535) return null;
	return { host: match[1] ?? "", port };
}
