/**
 * A tiny in-memory stand-in for RTCPeerConnection that behaves like the real
 * thing in the one way the P2P handshake depends on: a data channel opens only
 * after the OFFERER has applied the ANSWER (the answer carries the joiner's
 * ICE credentials and DTLS fingerprint). An offer alone never connects — real
 * Chromium and aiortc both behave this way (qa/p2p-spike/handshake-proof.mjs).
 *
 * Not a WebRTC implementation: no ICE, no DTLS, no loss. Frames are delivered
 * in order on the microtask queue.
 */

let counter = 0;
const byUfrag = new Map<string, FakePeerConnection>();

type Handler<E> = ((event: E) => void) | null;

export class FakeDataChannel {
	readyState: "connecting" | "open" | "closed" = "connecting";
	binaryType = "blob";
	onopen: Handler<unknown> = null;
	onclose: Handler<unknown> = null;
	onmessage: Handler<{ data: unknown }> = null;
	peer: FakeDataChannel | null = null;

	send(data: string | Uint8Array): void {
		if (this.readyState !== "open" || !this.peer) throw new Error("channel not open");
		const target = this.peer;
		const payload = typeof data === "string" ? data : data.slice().buffer;
		queueMicrotask(() => target.onmessage?.({ data: payload }));
	}

	close(): void {
		if (this.readyState === "closed") return;
		this.readyState = "closed";
		this.onclose?.({});
	}

	open(): void {
		this.readyState = "open";
		queueMicrotask(() => this.onopen?.({}));
	}
}

export class FakePeerConnection {
	readonly ufrag = `uf${++counter}`;
	iceGatheringState: "new" | "complete" = "new";
	iceConnectionState = "new";
	connectionState = "new";
	signalingState: "stable" | "have-local-offer" | "have-remote-offer" = "stable";
	localDescription: { type: string; sdp: string } | null = null;
	remoteUfrag: string | null = null;
	onicecandidate: Handler<{ candidate: null }> = null;
	onconnectionstatechange: Handler<unknown> = null;
	oniceconnectionstatechange: Handler<unknown> = null;
	ondatachannel: Handler<{ channel: FakeDataChannel }> = null;
	private channel: FakeDataChannel | null = null;
	private role: "offerer" | "answerer" | null = null;

	constructor(_config?: unknown) {
		byUfrag.set(this.ufrag, this);
	}

	createDataChannel(_label: string, _opts?: unknown): FakeDataChannel {
		this.channel = new FakeDataChannel();
		return this.channel;
	}

	private sdp(setup: string): string {
		return [
			"v=0",
			"o=- 1 2 IN IP4 127.0.0.1",
			"s=-",
			"t=0 0",
			"m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
			"c=IN IP4 0.0.0.0",
			`a=ice-ufrag:${this.ufrag}`,
			"a=ice-pwd:fakefakefakefakefakefake",
			"a=fingerprint:sha-256 AA:BB:CC",
			`a=setup:${setup}`,
			"a=candidate:1 1 udp 2113937151 192.168.1.9 50000 typ host",
			"",
		].join("\r\n");
	}

	async createOffer(): Promise<{ type: string; sdp: string }> {
		return { type: "offer", sdp: this.sdp("actpass") };
	}

	async createAnswer(): Promise<{ type: string; sdp: string }> {
		return { type: "answer", sdp: this.sdp("active") };
	}

	async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
		this.localDescription = desc;
		this.iceGatheringState = "complete";
		if (desc.type === "offer") {
			this.signalingState = "have-local-offer";
			this.role = "offerer";
		} else {
			this.signalingState = "stable";
			this.role = "answerer";
		}
	}

	async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
		const match = desc.sdp.match(/^a=ice-ufrag:(\S+)\s*$/m);
		if (!match?.[1]) throw new Error("remote description has no ICE credentials");
		this.remoteUfrag = match[1];
		if (desc.type === "offer") {
			this.signalingState = "have-remote-offer";
			return;
		}
		if (this.role !== "offerer" || this.signalingState !== "have-local-offer") {
			throw new Error("answer applied in the wrong state");
		}
		this.signalingState = "stable";
		const peer = byUfrag.get(this.remoteUfrag);
		if (!peer || peer.remoteUfrag !== this.ufrag || !this.channel) {
			// Wrong answer: the link never forms (ICE would time out in reality).
			return;
		}
		// Both ends now hold each other's details: the channel opens.
		const remote = new FakeDataChannel();
		remote.peer = this.channel;
		this.channel.peer = remote;
		peer.channel = remote;
		peer.ondatachannel?.({ channel: remote });
		for (const pc of [this, peer]) {
			pc.iceConnectionState = "connected";
			pc.connectionState = "connected";
		}
		this.channel.open();
		remote.open();
	}

	addEventListener(_type: string, _cb: () => void): void {
		// Gathering is already "complete" after setLocalDescription.
	}

	removeEventListener(_type: string, _cb: () => void): void {
		// see addEventListener
	}

	close(): void {
		this.connectionState = "closed";
		this.channel?.close();
		this.channel = null;
		byUfrag.delete(this.ufrag);
	}
}

/** Install the fake as the global RTCPeerConnection; returns the restore function. */
export function installFakeRtc(): () => void {
	const g = globalThis as Record<string, unknown>;
	const previous = g.RTCPeerConnection;
	g.RTCPeerConnection = FakePeerConnection;
	return () => {
		if (previous === undefined) delete g.RTCPeerConnection;
		else g.RTCPeerConnection = previous;
	};
}
