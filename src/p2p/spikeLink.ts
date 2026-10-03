/**
 * Phase 0 spike — a single WebRTC data-channel link.
 *
 * Roles are deterministic from the pairing flow: the device that generated
 * the code (the anchor) is the offerer; the device that joins with the code
 * is the answerer. No signalling service exists — the trimmed offer inside
 * the code is the whole handshake.
 *
 * Transport split (no byte-prefix ambiguity with Yjs updates):
 *   - binary channel traffic  → Yjs sync updates / sync messages (spikeYjs)
 *   - text channel traffic    → JSON control frames (ping/pong, hello)
 */

export type SpikeLinkRole = "offerer" | "answerer";

export interface SpikeLinkCallbacks {
	onOpen(): void;
	onClose(reason: string): void;
	/** Binary message: Yjs payload (spikeYjs owns the protocol). */
	onBinary(bytes: Uint8Array): void;
	/** Text message: control frame JSON string. */
	onControl(text: string): void;
	onLog(message: string): void;
}

export interface LinkStateSnapshot {
	role: SpikeLinkRole;
	iceGatheringState: RTCIceGatheringState | "unknown";
	iceConnectionState: RTCIceConnectionState | "unknown";
	rtcConnectionState: RTCPeerConnectionState | "unknown";
	channelState: RTCDataChannelState | "none";
	candidateTotal: number;
}

/** STUN wait budget for the anchor's pre-gathered offer. */
const GATHER_TIMEOUT_MS = 1500;

export class SpikeLink {
	private pc: RTCPeerConnection | null = null;
	private channel: RTCDataChannel | null = null;
	private closed = false;
	private candidateTotal = 0;
	private openFired = false;

	constructor(
		readonly role: SpikeLinkRole,
		private readonly iceServers: RTCIceServer[],
		private readonly cb: SpikeLinkCallbacks,
	) {}

	// ── offerer side ────────────────────────────────────────────────

	/**
	 * Create the data channel, set the local offer and pre-gather (host
	 * candidates immediately, STUN reflexive candidates within the budget).
	 * Resolves with the FULL local SDP (untrimmed) and whether gathering
	 * completed inside the budget.
	 */
	async createOffer(): Promise<{ sdp: string; gathering: "complete" | "timeout" }> {
		const pc = this.createPeerConnection();
		const channel = pc.createDataChannel("yaos-spike", { ordered: true });
		this.wireChannel(channel, "local");

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		const gathering = await this.waitForGathering(pc);
		const sdp = pc.localDescription?.sdp;
		if (!sdp) throw new Error("no local SDP after setLocalDescription");
		this.cb.onLog(
			`offer created (gathering ${gathering}, ${this.candidateTotal} candidates)`,
		);
		return { sdp, gathering };
	}

	// ── answerer side ───────────────────────────────────────────────

	async createAnswer(offerSdp: string): Promise<void> {
		const pc = this.createPeerConnection();
		// The anchor's data channel arrives here.
		pc.ondatachannel = (event) => {
			this.wireChannel(event.channel, "remote");
		};
		await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		this.cb.onLog(`answer set, awaiting connection`);
	}

	// ── shared ──────────────────────────────────────────────────────

	state(): LinkStateSnapshot {
		const pc = this.pc;
		return {
			role: this.role,
			iceGatheringState: pc ? pc.iceGatheringState : "unknown",
			iceConnectionState: pc ? pc.iceConnectionState : "unknown",
			rtcConnectionState: pc ? pc.connectionState : "unknown",
			channelState: this.channel?.readyState ?? "none",
			candidateTotal: this.candidateTotal,
		};
	}

	get hasOpenChannel(): boolean {
		return this.channel?.readyState === "open";
	}

	/** Binary Yjs payload. No-op (with a log) when the channel is not open. */
	sendBinary(bytes: Uint8Array): void {
		const channel = this.channel;
		if (!channel || channel.readyState !== "open") {
			this.cb.onLog(`sendBinary dropped (channel ${channel?.readyState ?? "none"})`);
			return;
		}
		channel.send(bytes);
	}

	sendControl(frame: Record<string, unknown>): void {
		const channel = this.channel;
		if (!channel || channel.readyState !== "open") {
			this.cb.onLog(`sendControl dropped (channel ${channel?.readyState ?? "none"})`);
			return;
		}
		channel.send(JSON.stringify(frame));
	}

	close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.channel?.close();
		} catch {
			// already closed
		}
		try {
			this.pc?.close();
		} catch {
			// already closed
		}
		this.channel = null;
		this.pc = null;
		if (!this.openFired) this.cb.onClose(reason);
	}

	destroy(): void {
		this.close("destroyed");
	}

	// ── internals ───────────────────────────────────────────────────

	private createPeerConnection(): RTCPeerConnection {
		const pc = new RTCPeerConnection({
			iceServers: this.iceServers,
			iceCandidatePoolSize: 0,
		});
		this.pc = pc;

		pc.onicecandidate = (event) => {
			if (!event.candidate) {
				this.cb.onLog("gathering finished (end-of-candidates)");
				return;
			}
			this.candidateTotal++;
			const type = this.candidateType(event.candidate.candidate);
			this.cb.onLog(`candidate ${type} (#${this.candidateTotal})`);
		};
		pc.onconnectionstatechange = () => {
			const s = pc.connectionState;
			this.cb.onLog(`connectionState → ${s}`);
			if (s === "failed" || s === "closed" || s === "disconnected") {
				this.fireCloseOnce(s);
			}
		};
		pc.oniceconnectionstatechange = () => {
			this.cb.onLog(`iceConnectionState → ${pc.iceConnectionState}`);
		};
		return pc;
	}

	private wireChannel(channel: RTCDataChannel, side: "local" | "remote"): void {
		this.channel = channel;
		channel.binaryType = "arraybuffer";
		channel.onopen = () => {
			this.cb.onLog(`data channel open (${side})`);
			this.fireOpenOnce();
		};
		channel.onclose = () => {
			this.cb.onLog(`data channel closed (${side})`);
			this.fireCloseOnce("channel-closed");
		};
		channel.onmessage = (event: MessageEvent) => {
			if (typeof event.data === "string") {
				this.cb.onControl(event.data);
				return;
			}
			const buffer = event.data as ArrayBuffer;
			this.cb.onBinary(new Uint8Array(buffer));
		};
	}

	private fireOpenOnce(): void {
		if (this.openFired || this.closed) return;
		this.openFired = true;
		this.cb.onOpen();
	}

	private fireCloseOnce(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.cb.onLog(`link closed (${reason})`);
		this.cb.onClose(reason);
	}

	private candidateType(candidateLine: string): string {
		const match = candidateLine.match(/\s+typ\s+([a-z]+)\b/);
		return match?.[1] ?? "unknown";
	}

	private waitForGathering(pc: RTCPeerConnection): Promise<"complete" | "timeout"> {
		if (pc.iceGatheringState === "complete") return Promise.resolve("complete");
		return new Promise((resolve) => {
			const timer = window.setTimeout(() => {
				pc.removeEventListener("icegatheringstatechange", onState);
				resolve("timeout");
			}, GATHER_TIMEOUT_MS);
			const onState = (): void => {
				if (pc.iceGatheringState === "complete") {
					window.clearTimeout(timer);
					pc.removeEventListener("icegatheringstatechange", onState);
					resolve("complete");
				}
			};
			pc.addEventListener("icegatheringstatechange", onState);
		});
	}
}
