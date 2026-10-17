/**
 * Test rig for the Local network carrier: real sockets on loopback, real
 * certificates, real discovery packets (aimed at loopback instead of the LAN).
 */
import { generateLanCert, type LanCert } from "../../src/lan-carrier/lanCert";
import { generateLanKey } from "../../src/lan-carrier/lanAuth";
import { LanHub, type LanHubOptions, type LanLink } from "../../src/lan-carrier/lanHub";

/** The carrier code uses `window.setTimeout` like the rest of the plugin. */
(globalThis as { window?: unknown }).window ??= globalThis;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(cond: () => boolean, ms = 4000, step = 10): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await sleep(step);
	}
	return cond();
}

export interface RigDevice {
	id: string;
	name: string;
	cert: LanCert;
	pins: Map<string, string>;
	hub: LanHub;
	ready: LanLink[];
}

export interface RigOptions extends Partial<Omit<LanHubOptions, "onLinkReady" | "cert" | "getPin" | "setPin">> {
	id: string;
	key: string;
	cert?: LanCert;
	pins?: Map<string, string>;
	onLinkReady?: (link: LanLink) => void;
}

const certs = new Map<string, LanCert>();
/** Key generation takes a few ms; reuse a certificate per device id inside one test run. */
export function certFor(id: string): LanCert {
	let cert = certs.get(id);
	if (!cert) {
		cert = generateLanCert(`test ${id}`);
		certs.set(id, cert);
	}
	return cert;
}

export function makeDevice(options: RigOptions): RigDevice {
	const cert = options.cert ?? certFor(options.id);
	const pins = options.pins ?? new Map<string, string>();
	const ready: LanLink[] = [];
	const hub = new LanHub({
		deviceId: options.id,
		deviceName: options.deviceName ?? `Device ${options.id}`,
		vaultId: options.vaultId ?? "vault-test",
		key: options.key,
		port: options.port ?? 0,
		discoveryPort: options.discoveryPort ?? 0,
		discoveryEnabled: options.discoveryEnabled ?? false,
		manualPeers: options.manualPeers ?? [],
		cert,
		getPin: (id) => pins.get(id),
		setPin: (id, fp) => { pins.set(id, fp); },
		onLinkReady: (link) => {
			ready.push(link);
			options.onLinkReady?.(link);
		},
		reconnectBaseMs: options.reconnectBaseMs ?? 50,
		reconnectMaxMs: options.reconnectMaxMs ?? 400,
		dialDelayMs: options.dialDelayMs ?? 0,
		handshakeTimeoutMs: options.handshakeTimeoutMs ?? 3000,
		connectTimeoutMs: options.connectTimeoutMs ?? 2000,
		heartbeatMs: options.heartbeatMs,
		heartbeatTimeoutMs: options.heartbeatTimeoutMs,
		discoveryTargets: options.discoveryTargets,
		acceptAddress: options.acceptAddress ?? (() => true),
		canAnnounce: options.canAnnounce ?? (() => true),
		log: options.log,
	});
	return { id: options.id, name: options.deviceName ?? `Device ${options.id}`, cert, pins, hub, ready };
}

export { generateLanKey };

// ---------------------------------------------------------------------------
// A full node: a Y.Doc, the transport and a real hub (used by the transport tests)
// ---------------------------------------------------------------------------
import * as Y from "yjs";
import { LanTransport, type LanTransportOptions } from "../../src/lan-carrier/lanTransport";

export interface RigNode {
	id: string;
	doc: Y.Doc;
	transport: LanTransport;
	pins: Map<string, string>;
	port: () => number;
	/** Link to another node by typing its address. */
	linkTo: (other: RigNode) => void;
	receipts: string[];
	problems: string[];
	stop: () => void;
}

export function makeNode(id: string, key: string, extra: Partial<LanTransportOptions> = {}, hubExtra: Partial<LanHubOptions> = {}): RigNode {
	const doc = new Y.Doc();
	const pins = new Map<string, string>();
	const problems: string[] = [];
	const transport = new LanTransport(doc, {
		ackDelayMs: 10,
		onProblem: (m) => problems.push(m),
		...extra,
		createHub: (hooks) => new LanHub({
			deviceId: id,
			deviceName: `Device ${id}`,
			vaultId: "vault-test",
			key,
			port: 0,
			discoveryPort: 0,
			discoveryEnabled: false,
			manualPeers: [],
			cert: certFor(id),
			getPin: (d) => pins.get(d),
			setPin: (d, fp) => { pins.set(d, fp); },
			onLinkReady: hooks.onLinkReady,
			onStatusChanged: hooks.onStatusChanged,
			reconnectBaseMs: 50,
			reconnectMaxMs: 300,
			dialDelayMs: 0,
			...hubExtra,
		}),
	});
	const manual: string[] = [];
	const receipts: string[] = [];
	transport.on("custom-message", (m) => receipts.push(m));
	const node: RigNode = {
		id, doc, transport, pins, receipts, problems,
		port: () => transport.hub.status().port ?? 0,
		linkTo: (other) => {
			manual.push(`127.0.0.1:${other.port()}`);
			transport.hub.setManualPeers(manual);
		},
		stop: () => transport.destroy(),
	};
	return node;
}
