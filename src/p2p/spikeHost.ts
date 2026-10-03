/**
 * Phase 0 spike — session host.
 *
 * Owns the lifecycle of one spike pairing: code generation (anchor) or
 * code join, the link, the Yjs document, control frames (ping/pong RTT),
 * and a timestamped event log that is the primary evidence channel for the
 * feasibility checklist (docs/p2p/feasibility.md).
 *
 * This class is UI-free: the settings modal and the __YAOS_P2P_DEBUG__ CDP
 * API are thin views over it.
 */

import {
	type CandidateStats,
	type DecodedPairingCode,
	decodePairingCode,
	encodePairingCode,
	countCandidateTypes,
	trimSdpForPairing,
} from "./spikeOffer";
import { SpikeLink, type LinkStateSnapshot } from "./spikeLink";
import { SpikeYjs, type SpikeYjsStats } from "./spikeYjs";

export type SpikePhase =
	| "idle"
	| "awaiting-peer" // anchor: code out, channel not open yet
	| "connecting" // joiner: answer set, channel not open yet
	| "connected"
	| "closed"
	| "error";

export interface SpikeLogEntry {
	t: number;
	msg: string;
}

export interface SpikeState {
	phase: SpikePhase;
	error: string | null;
	code: string | null;
	deepLink: string | null;
	codeCharLength: number;
	codeByteLength: number;
	candidates: CandidateStats;
	gathering: "complete" | "timeout" | null;
	link: LinkStateSnapshot | null;
	yjs: SpikeYjsStats | null;
	lastRttMs: number | null;
	iceServers: string[];
	/** When the current link last opened (ms epoch); null when never/idle. */
	lastSeen: number | null;
}

export interface TurnOverride {
	url: string;
	username?: string;
	credential?: string;
}

/** Public STUN used for the pre-gather. Statelessness kept on purpose:
 *  the plan allows public STUN but no author-hosted service (TURN is
 *  user-supplied via TurnOverride for the T0.5 matrix). */
const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];

export class P2pSpikeHost {
	private link: SpikeLink | null = null;
	private yjs: SpikeYjs | null = null;
	private yjsDetach: (() => void) | null = null;
	private phase: SpikePhase = "idle";
	private error: string | null = null;
	private entries: SpikeLogEntry[] = [];
	private turnOverrides: TurnOverride[] = [];
	private code: string | null = null;
	private deepLink: string | null = null;
	private codeLengths = { charLength: 0, byteLength: 0 };
	private candidates: CandidateStats = {
		byType: { host: 0, srflx: 0, prflx: 0, relay: 0 },
		total: 0,
	};
	private gathering: "complete" | "timeout" | null = null;
	private lastRttMs: number | null = null;
	private lastSeen: number | null = null;
	private pendingPings = new Map<number, { sentAt: number; timer: number }>();
	private pingCounter = 0;
	private vaultSecret: string;

	constructor(private readonly getVaultId: () => string) {
		this.vaultSecret = randomToken(32);
	}

	// ── public: pairing ─────────────────────────────────────────────

	/** Anchor side: pre-gather, trim, encode. Resolves once the offer exists. */
	async generate(): Promise<{ code: string; deepLink: string; gathering: "complete" | "timeout" }> {
		this.resetSession("generate");
		const yjs = new SpikeYjs();
		this.yjs = yjs;
		const link = new SpikeLink("offerer", this.iceServers(), {
			onOpen: () => this.onLinkOpen(),
			onClose: (reason) => this.onLinkClose(reason),
			onBinary: (bytes) => yjs.onMessage(bytes),
			onControl: (text) => this.onControl(text),
			onLog: (msg) => this.log(msg),
		});
		this.link = link;
		this.phase = "connecting";
		this.error = null;
		try {
			const { sdp, gathering } = await link.createOffer();
			const trimmed = trimSdpForPairing(sdp);
			const code = encodePairingCode({
				vaultId: this.getVaultId(),
				vaultSecret: this.vaultSecret,
				sdp: trimmed,
			});
			this.code = code;
			this.deepLink = `obsidian://yaos?action=p2p-pair&code=${encodeURIComponent(code)}`;
			const decoded = decodePairingCode(code);
			this.codeLengths = {
				charLength: decoded?.charLength ?? code.length,
				byteLength: decoded?.byteLength ?? new TextEncoder().encode(code).length,
			};
			this.candidates = countCandidateTypes(sdp);
			this.gathering = gathering;
			this.phase = "awaiting-peer";
			this.log(
				`code ready (${this.codeLengths.charLength} chars, ${this.codeLengths.byteLength} bytes, ` +
					`${this.candidates.total} candidates, gathering ${gathering})`,
			);
			return { code, deepLink: this.deepLink, gathering };
		} catch (err) {
			this.phase = "error";
			this.error = formatUnknown(err);
			this.log(`generate failed: ${this.error}`);
			throw err;
		}
	}

	/** Joiner side: decode the code and answer. */
	async join(rawCode: string): Promise<{ vaultId: string; candidates: CandidateStats }> {
		const decoded: DecodedPairingCode | null = decodePairingCode(rawCode);
		if (!decoded) {
			throw new Error("not a valid pairing code (expected YAOS-P2P1:…)");
		}
		const currentVaultId = this.getVaultId();
		if (decoded.vaultId !== currentVaultId) {
			this.log(
				`vault id mismatch (code: ${decoded.vaultId}, this device: ${currentVaultId}) — ` +
					`continuing; the spike does not gate on vault identity yet`,
			);
		}
		this.resetSession("join");
		const yjs = new SpikeYjs();
		this.yjs = yjs;
		const link = new SpikeLink("answerer", this.iceServers(), {
			onOpen: () => this.onLinkOpen(),
			onClose: (reason) => this.onLinkClose(reason),
			onBinary: (bytes) => yjs.onMessage(bytes),
			onControl: (text) => this.onControl(text),
			onLog: (msg) => this.log(msg),
		});
		this.link = link;
		this.phase = "connecting";
		this.error = null;
		try {
			await link.createAnswer(decoded.sdp);
			this.candidates = countCandidateTypes(decoded.sdp);
			this.log(`joined (offer carries ${this.candidates.total} candidates)`);
			return { vaultId: decoded.vaultId, candidates: this.candidates };
		} catch (err) {
			this.phase = "error";
			this.error = formatUnknown(err);
			this.log(`join failed: ${this.error}`);
			throw err;
		}
	}

	// ── public: probing ─────────────────────────────────────────────

	/** One ping/pong round trip over the text channel. */
	ping(timeoutMs = 5000): Promise<number | null> {
		const id = ++this.pingCounter;
		const sentAt = Date.now();
		return new Promise((resolve) => {
			if (!this.link?.hasOpenChannel) {
				resolve(null);
				return;
			}
			const timer = window.setTimeout(() => {
				this.pendingPings.delete(id);
				resolve(null);
			}, timeoutMs);
			this.pendingPings.set(id, { sentAt, timer });
			this.link.sendControl({ t: "ping", id, at: sentAt });
		});
	}

	yjsEdit(replaceText: string): void {
		this.yjs?.edit(replaceText);
	}

	yjsRead(): string {
		// toJSON() is YText's declared string accessor (its .d.ts omits
		// toString(), so .toString() trips no-base-to-string).
		return this.yjs ? this.yjs.text.toJSON() : "";
	}

	// ── public: teardown / config ───────────────────────────────────

	close(reason = "user-closed"): void {
		this.log(`closing (${reason})`);
		this.resetSession(reason);
	}

	destroy(): void {
		this.resetSession("destroyed");
	}

	setTurnOverrides(turns: TurnOverride[]): void {
		this.turnOverrides = turns.filter((t) => t.url.trim().length > 0);
		this.log(`ICE overrides set (${this.turnOverrides.length} TURN server(s)) — applies on next pairing`);
	}

	get iceServerList(): string[] {
		return this.iceServers().map((s) =>
			Array.isArray(s.urls) ? s.urls.join(" ") : s.urls,
		);
	}

	// ── public: views ───────────────────────────────────────────────

	state(): SpikeState {
		return {
			phase: this.phase,
			error: this.error,
			code: this.code,
			deepLink: this.deepLink,
			codeCharLength: this.codeLengths.charLength,
			codeByteLength: this.codeLengths.byteLength,
			candidates: this.candidates,
			gathering: this.gathering,
			link: this.link ? this.link.state() : null,
			yjs: this.yjs ? this.yjs.stats() : null,
		lastRttMs: this.lastRttMs,
		iceServers: this.iceServerList,
		lastSeen: this.lastSeen,
	};
	}

	logEntries(limit = 400): SpikeLogEntry[] {
		return this.entries.slice(-limit);
	}

	clearLog(): void {
		this.entries = [];
	}

	log(msg: string): void {
		this.entries.push({ t: Date.now(), msg });
		if (this.entries.length > 2000) {
			this.entries.splice(0, this.entries.length - 2000);
		}
	}

	// ── internals ───────────────────────────────────────────────────

	private iceServers(): RTCIceServer[] {
		const list: RTCIceServer[] = [{ urls: DEFAULT_STUN_URLS }];
		for (const turn of this.turnOverrides) {
			const server: RTCIceServer = { urls: turn.url.trim() };
			if (turn.username) server.username = turn.username;
			if (turn.credential) server.credential = turn.credential;
			list.push(server);
		}
		return list;
	}

	private onLinkOpen(): void {
		this.phase = "connected";
		this.lastSeen = Date.now();
		this.log("LINK OPEN — connecting Yjs");
		if (this.yjs) {
			this.yjsDetach?.();
			this.yjsDetach = this.yjs.attach((bytes) => this.link?.sendBinary(bytes));
		}
		this.link?.sendControl({ t: "hello", phase: "connected" });
	}

	private onLinkClose(reason: string): void {
		if (this.phase === "idle") return;
		this.phase = "closed";
		this.log(`LINK CLOSED (${reason})`);
		this.yjsDetach?.();
		this.yjsDetach = null;
		this.link = null;
		for (const { timer } of this.pendingPings.values()) window.clearTimeout(timer);
		this.pendingPings.clear();
	}

	private onControl(text: string): void {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(text) as Record<string, unknown>;
		} catch {
			this.log(`dropping malformed control frame`);
			return;
		}
		const type = typeof frame.t === "string" ? frame.t : "";
		if (type === "ping") {
			const id = typeof frame.id === "number" ? frame.id : null;
			const at = typeof frame.at === "number" ? frame.at : null;
			if (id !== null && at !== null) {
				this.link?.sendControl({ t: "pong", id, at });
			}
			return;
		}
		if (type === "pong") {
			const id = typeof frame.id === "number" ? frame.id : null;
			if (id === null) return;
			const pending = this.pendingPings.get(id);
			if (pending) {
				this.pendingPings.delete(id);
				window.clearTimeout(pending.timer);
				const rtt = Date.now() - pending.sentAt;
				this.lastRttMs = rtt;
				this.log(`ping RTT ${rtt} ms`);
			}
			return;
		}
		if (type === "hello") {
			this.log("peer hello received");
		}
	}

	private resetSession(reason: string): void {
		if (this.yjsDetach) {
			this.yjsDetach();
			this.yjsDetach = null;
		}
		if (this.link) {
			this.link.destroy();
			this.link = null;
		}
		if (this.yjs) {
			this.yjs.doc.destroy();
			this.yjs = null;
		}
		for (const { timer } of this.pendingPings.values()) window.clearTimeout(timer);
		this.pendingPings.clear();
		this.code = null;
		this.deepLink = null;
		this.codeLengths = { charLength: 0, byteLength: 0 };
		this.gathering = null;
		this.error = null;
		this.phase = "idle";
		this.lastSeen = null;
		this.log(`session reset (${reason})`);
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function randomToken(bytes: number): string {
	const raw = new Uint8Array(bytes);
	crypto.getRandomValues(raw);
	let hex = "";
	for (const b of raw) hex += b.toString(16).padStart(2, "0");
	return hex;
}

function formatUnknown(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
