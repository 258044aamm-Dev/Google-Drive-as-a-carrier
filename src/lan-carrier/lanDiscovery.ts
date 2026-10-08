/**
 * Finding other devices on the same network: a small UDP broadcast.
 *
 * Ported from Local Sync's discovery-manager.ts (MIT, liuboacean): every 5
 * seconds the device broadcasts {deviceId, deviceName, port} to the local
 * network; devices that hear it answer once, and a device that has been silent
 * for 30 seconds is marked lost. Only private address ranges are accepted
 * (10.x, 192.168.x, 172.16-31.x).
 *
 * Added: the announcement carries a short hash of the vault id, so devices of
 * another vault on the same network are ignored. Discovery is only a hint where
 * to connect; who may connect is decided by the key-bound sign-in.
 */
import type * as Dgram from "dgram";
import { LAN_DEVICE_TIMEOUT_MS, LAN_DISCOVERY_INTERVAL_MS } from "./lanConstants";
import { loadLanNode } from "./lanNode";

export interface LanDiscoveredDevice {
	deviceId: string;
	deviceName: string;
	address: string;
	port: number;
	firstSeen: number;
	lastSeen: number;
	online: boolean;
}

interface Announcement {
	type: "DISCOVERY_ANNOUNCE" | "DISCOVERY_RESPONSE";
	deviceId: string;
	deviceName: string;
	port: number;
	vault: string;
}

export function isPrivateIp(ip: string): boolean {
	const parts = ip.split(".");
	if (parts.length !== 4) return false;
	const first = parseInt(parts[0] ?? "", 10);
	const second = parseInt(parts[1] ?? "", 10);
	if (first === 10) return true;
	if (first === 192 && second === 168) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	return false;
}

/** The first private IPv4 address of this machine, or null when it has none. */
export function getPrivateIp(): string | null {
	const interfaces = loadLanNode().os.networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const addr of interfaces[name] ?? []) {
			if (addr.family === "IPv4" && !addr.internal && isPrivateIp(addr.address)) return addr.address;
		}
	}
	return null;
}

/** Short, non-reversible tag of the vault id (so announcements do not carry the id itself). */
export function vaultTag(vaultId: string): string {
	return loadLanNode().crypto.createHash("sha256").update(`yaos-lan1|${vaultId}`).digest("hex").slice(0, 16);
}

export interface LanDiscoveryOptions {
	deviceId: string;
	deviceName: string;
	/** `vaultTag()` of the vault this device syncs. */
	vault: string;
	/** The TCP port of this device's link server. */
	syncPort: number;
	discoveryPort: number;
	onFound: (device: LanDiscoveredDevice) => void;
	onLost: (device: LanDiscoveredDevice) => void;
	log?: (message: string) => void;
	/** Where announcements are sent. Default: the whole local network. Tests aim at loopback. */
	targets?: Array<{ address: string; port: number }>;
	/** Which senders are believed. Default: private address ranges only. */
	acceptAddress?: (address: string) => boolean;
	/** Whether this machine may announce at all. Default: it must have a private address. */
	canAnnounce?: () => boolean;
	intervalMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

export class LanDiscovery {
	private socket: Dgram.Socket | null = null;
	private announceTimer: number | null = null;
	private cleanupTimer: number | null = null;
	private running = false;
	private readonly known = new Map<string, LanDiscoveredDevice>();
	private readonly now: () => number;

	constructor(private readonly options: LanDiscoveryOptions) {
		this.now = options.now ?? (() => Date.now());
	}

	get isRunning(): boolean {
		return this.running;
	}

	devices(): LanDiscoveredDevice[] {
		return Array.from(this.known.values());
	}

	/** Bind the UDP port and start announcing. Never throws: a busy port is logged and discovery stays off. */
	start(): Promise<void> {
		if (this.running) return Promise.resolve();
		this.running = true;
		return new Promise<void>((resolve) => {
			try {
				const socket = loadLanNode().dgram.createSocket({ type: "udp4", reuseAddr: true });
				this.socket = socket;
				socket.on("message", (msg, rinfo) => this.onMessage(msg, rinfo.address, rinfo.port));
				socket.on("error", (err) => {
					this.options.log?.(`discovery error: ${err.message}`);
				});
				socket.bind(this.options.discoveryPort, () => {
					try {
						socket.setBroadcast(true);
					} catch {
						// some systems refuse; announcements to specific targets still work
					}
					this.announce();
					this.announceTimer = window.setInterval(() => this.announce(), this.options.intervalMs ?? LAN_DISCOVERY_INTERVAL_MS);
					this.cleanupTimer = window.setInterval(() => this.cleanup(), (this.options.timeoutMs ?? LAN_DEVICE_TIMEOUT_MS) / 2);
					resolve();
				});
				socket.once("error", () => resolve());
			} catch (err) {
				this.options.log?.(`could not start discovery: ${err instanceof Error ? err.message : String(err)}`);
				this.running = false;
				resolve();
			}
		});
	}

	stop(): void {
		this.running = false;
		if (this.announceTimer !== null) window.clearInterval(this.announceTimer);
		if (this.cleanupTimer !== null) window.clearInterval(this.cleanupTimer);
		this.announceTimer = null;
		this.cleanupTimer = null;
		try {
			this.socket?.close();
		} catch {
			// already closed
		}
		this.socket = null;
	}

	/** Announce now (also used by tests). */
	announce(): void {
		if (!this.socket || !this.running) return;
		const canAnnounce = this.options.canAnnounce ?? (() => getPrivateIp() !== null);
		if (!canAnnounce()) return;
		const payload = this.encode("DISCOVERY_ANNOUNCE");
		const targets = this.options.targets ?? [{ address: "255.255.255.255", port: this.options.discoveryPort }];
		for (const target of targets) {
			try {
				this.socket.send(payload, 0, payload.length, target.port, target.address);
			} catch {
				// the network may be down; the next round tries again
			}
		}
	}

	private encode(type: Announcement["type"]): Buffer {
		const message: Announcement = {
			type,
			deviceId: this.options.deviceId,
			deviceName: this.options.deviceName,
			port: this.options.syncPort,
			vault: this.options.vault,
		};
		return Buffer.from(JSON.stringify(message));
	}

	private onMessage(raw: Buffer, address: string, senderPort: number): void {
		if (raw.length > 2000) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString("utf8"));
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const m = parsed as Record<string, unknown>;
		if (m.type !== "DISCOVERY_ANNOUNCE" && m.type !== "DISCOVERY_RESPONSE") return;
		if (typeof m.deviceId !== "string" || m.deviceId.length === 0 || m.deviceId.length > 64) return;
		if (typeof m.deviceName !== "string" || m.deviceName.length > 100) return;
		if (typeof m.port !== "number" || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return;
		if (m.vault !== this.options.vault) return;
		if (m.deviceId === this.options.deviceId) return;
		const accept = this.options.acceptAddress ?? isPrivateIp;
		if (!accept(address)) return;

		const now = this.now();
		const existing = this.known.get(m.deviceId);
		if (existing) {
			const wasOffline = !existing.online;
			existing.lastSeen = now;
			existing.address = address;
			existing.port = m.port;
			existing.deviceName = m.deviceName;
			existing.online = true;
			if (wasOffline) this.options.onFound(existing);
		} else {
			const device: LanDiscoveredDevice = {
				deviceId: m.deviceId,
				deviceName: m.deviceName,
				address,
				port: m.port,
				firstSeen: now,
				lastSeen: now,
				online: true,
			};
			this.known.set(m.deviceId, device);
			this.options.log?.(`found ${m.deviceName} at ${address}:${m.port}`);
			this.options.onFound(device);
		}
		if (m.type === "DISCOVERY_ANNOUNCE" && this.socket && this.running) {
			const reply = this.encode("DISCOVERY_RESPONSE");
			try {
				this.socket.send(reply, 0, reply.length, senderPort, address);
			} catch {
				// best effort
			}
		}
	}

	private cleanup(): void {
		const now = this.now();
		const timeout = this.options.timeoutMs ?? LAN_DEVICE_TIMEOUT_MS;
		for (const device of this.known.values()) {
			if (device.online && now - device.lastSeen > timeout) {
				device.online = false;
				this.options.log?.(`lost ${device.deviceName}`);
				this.options.onLost(device);
			}
		}
	}
}
