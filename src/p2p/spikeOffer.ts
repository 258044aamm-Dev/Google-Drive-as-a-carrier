/**
 * Phase 0 spike — pairing code and SDP trimming (pure functions).
 *
 * The pairing code carries the anchor's pre-gathered, trimmed SDP offer so
 * the joiner can open a data channel from the code alone (no signalling
 * service). Format (see docs/p2p-plan.md §4.4):
 *
 *   YAOS-P2P1:<vaultId>:<vaultSecret>:<b64url(sdp)>
 *
 * All three segments are colon-free by construction, so the code splits
 * unambiguously. The vault secret is carried but NOT yet used for
 * authentication — that is Phase 1 (the spike proves transport only).
 *
 * WebRTC needs the answer on the offering side as well (ICE credentials and
 * the DTLS fingerprint of the joiner), so pairing is a two-way exchange:
 *
 *   YAOS-P2P1-ANS:<vaultId>:<offerId>:<b64url(sdp)>
 *
 * The joiner shows this answer code, the creator pastes it. `offerId` is the
 * ICE username fragment of the offer the answer belongs to, so an answer for
 * an older code is refused instead of silently failing to connect.
 */

export const SPIKE_CODE_PREFIX = "YAOS-P2P1";
export const SPIKE_CODE_VERSION = 1;
export const SPIKE_ANSWER_PREFIX = "YAOS-P2P1-ANS";

export interface PairingCodeParts {
	vaultId: string;
	vaultSecret: string;
	sdp: string;
}

export interface DecodedPairingCode extends PairingCodeParts {
	/** Format version encoded by the code prefix (YAOS-P2P1 → 1). */
	version: number;
	/** Total code length in UTF-16 code units (what a QR/clipboard sees). */
	charLength: number;
	/** Total code length in UTF-8 bytes (QR payload cost). */
	byteLength: number;
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

const B64URL =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64_LOOKUP[B64URL[i]!] = i;

export function toB64Url(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i]!;
		const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
		const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
		out += B64URL[b0 >> 2]!;
		out += B64URL[((b0 & 3) << 4) | (b1 >> 4)]!;
		out += i + 1 < bytes.length ? B64URL[((b1 & 15) << 2) | (b2 >> 6)]! : "";
		out += i + 2 < bytes.length ? B64URL[b2 & 63]! : "";
	}
	return out;
}

export function fromB64Url(text: string): Uint8Array | null {
	const s = text.replace(/=+$/, "");
	if (s.length === 0) return null;
	for (let i = 0; i < s.length; i++) {
		if (!(s[i]! in B64_LOOKUP)) return null;
	}
	const bytes: number[] = [];
	for (let i = 0; i < s.length; i += 4) {
		const n0 = B64_LOOKUP[s[i]!]!;
		const n1 = i + 1 < s.length ? B64_LOOKUP[s[i + 1]!]! : 0;
		const n2 = i + 2 < s.length ? B64_LOOKUP[s[i + 2]!]! : 0;
		const n3 = i + 3 < s.length ? B64_LOOKUP[s[i + 3]!]! : 0;
		bytes.push((n0 << 2) | (n1 >> 4));
		if (i + 2 < s.length) bytes.push(((n1 & 15) << 4) | (n2 >> 2));
		if (i + 3 < s.length) bytes.push(((n2 & 3) << 6) | n3);
	}
	return new Uint8Array(bytes);
}

export function toB64UrlText(text: string): string {
	const bytes = new TextEncoder().encode(text);
	return toB64Url(bytes);
}

export function fromB64UrlText(text: string): string | null {
	const bytes = fromB64Url(text);
	if (bytes === null) return null;
	return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// SDP trimming
// ---------------------------------------------------------------------------

/**
 * Attribute prefixes kept inside a media section. Everything else
 * (a=msid, a=ssrc, a=rtpmap, a=ice-options:…, etc.) is dropped: the spike
 * only carries one data channel, and Chromium's data-channel negotiation
 * does not require any other media attributes.
 */
const KEPT_MEDIA_ATTRS: readonly string[] = [
	"a=mid:",
	"a=ice-ufrag:",
	"a=ice-pwd:",
	"a=fingerprint:",
	"a=setup:",
	"a=connection:",
	"a=ice-options:",
	"a=rtcp-mux:",
	"a=sctp-port:",
	"a=max-message-size:",
];

const KEPT_MEDIA_ATTRS_EXACT: readonly string[] = [
	"a=end-of-candidates",
];

function isSessionLine(line: string): boolean {
	return (
		line.startsWith("v=") ||
		line.startsWith("o=") ||
		line.startsWith("s=") ||
		line.startsWith("t=")
	);
}

/**
 * Trim a full SDP offer down to the minimum that opens a data channel:
 * session header (v/o/s/t), and — for the FIRST `m=application` section
 * only — the m= line, the connection line, ICE/DTLS attributes, and every
 * `a=candidate:` line in gathered order. Every other media section (e.g.
 * Chromium's default `m=audio`) is dropped wholesale, including its
 * `c=`/`a=mid:` lines, which would otherwise be carried as junk.
 *
 * Idempotent: trimming an already-trimmed SDP returns it unchanged.
 */
export function trimSdpForPairing(sdp: string): string {
	const lines = sdp.replace(/\r\n/g, "\n").split("\n");
	const kept: string[] = [];
	// "session" before the first m=; then exactly one section may be
	// "application" — the first m=application. Everything else is "other".
	let section: "session" | "application" | "other" = "session";
	let sawApplication = false;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (line === "") continue;

		if (line.startsWith("m=")) {
			const isApp = line.startsWith("m=application") && !sawApplication;
			if (isApp) {
				section = "application";
				sawApplication = true;
				kept.push(line);
			} else {
				section = "other";
			}
			continue;
		}
		if (section === "session") {
			if (isSessionLine(line)) kept.push(line);
			continue;
		}
		if (section !== "application") continue;
		if (line.startsWith("c=") || line.startsWith("a=candidate:")) {
			kept.push(line);
			continue;
		}
		if (
			KEPT_MEDIA_ATTRS_EXACT.includes(line) ||
			KEPT_MEDIA_ATTRS.some((prefix) => line.startsWith(prefix))
		) {
			kept.push(line);
			continue;
		}
		// Everything else (msid, ssrc, rtpmap, ext, …) drops.
	}

	return kept.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Candidate accounting (T0.5 NAT-matrix evidence)
// ---------------------------------------------------------------------------

export type CandidateType = "host" | "srflx" | "prflx" | "relay";

export interface CandidateStats {
	byType: Record<CandidateType, number>;
	total: number;
}

const CANDIDATE_TYPE_ORDER: readonly CandidateType[] = [
	"host",
	"srflx",
	"prflx",
	"relay",
];

/**
 * Count ICE candidates by type from an SDP (`a=candidate:` lines) or a raw
 * trickle list (`candidate:` lines).
 */
export function countCandidateTypes(sdp: string): CandidateStats {
	const stats: CandidateStats = {
		byType: { host: 0, srflx: 0, prflx: 0, relay: 0 },
		total: 0,
	};
	for (const line of sdp.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("a=candidate:") && !trimmed.startsWith("candidate:")) continue;
		const match = trimmed.match(/\s+typ\s+([a-z]+)\b/);
		const type = match?.[1] as CandidateType | undefined;
		if (type && CANDIDATE_TYPE_ORDER.includes(type)) {
			stats.byType[type]++;
			stats.total++;
		}
	}
	return stats;
}

// ---------------------------------------------------------------------------
// Code build / parse
// ---------------------------------------------------------------------------

function assertColonFree(value: string, what: string): void {
	if (value.includes(":")) {
		throw new Error(`${what} must not contain ':'`);
	}
}

export function encodePairingCode(parts: PairingCodeParts): string {
	if (parts.vaultId.length === 0) throw new Error("vaultId is required");
	if (parts.vaultSecret.length === 0) throw new Error("vaultSecret is required");
	if (!parts.sdp.startsWith("v=")) throw new Error("sdp must start with 'v='");
	assertColonFree(parts.vaultId, "vaultId");
	assertColonFree(parts.vaultSecret, "vaultSecret");
	return `${SPIKE_CODE_PREFIX}:${parts.vaultId}:${parts.vaultSecret}:${toB64UrlText(parts.sdp)}`;
}

export function decodePairingCode(code: string): DecodedPairingCode | null {
	if (typeof code !== "string") return null;
	const trimmed = code.trim();
	if (!trimmed.startsWith(SPIKE_CODE_PREFIX + ":")) return null;
	const segments = trimmed.split(":");
	if (segments.length !== 4) return null;
	const [, vaultId, vaultSecret, sdpB64] = segments;
	if (!vaultId || !vaultSecret) return null;
	const sdp = fromB64UrlText(sdpB64 ?? "");
	if (sdp === null || !sdp.startsWith("v=")) return null;
	const bytes = new TextEncoder().encode(trimmed);
	return {
		version: SPIKE_CODE_VERSION,
		vaultId,
		vaultSecret,
		sdp,
		charLength: trimmed.length,
		byteLength: bytes.length,
	};
}

// ---------------------------------------------------------------------------
// Answer code (the joiner's reply)
// ---------------------------------------------------------------------------

export interface AnswerCodeParts {
	vaultId: string;
	/** ICE username fragment of the offer this answer belongs to. */
	offerId: string;
	sdp: string;
}

export interface DecodedAnswerCode extends AnswerCodeParts {
	charLength: number;
	byteLength: number;
}

/** The ICE username fragment (`a=ice-ufrag:`) of an SDP, or null. */
export function extractIceUfrag(sdp: string): string | null {
	const match = sdp.match(/^a=ice-ufrag:(\S+)\s*$/m);
	return match?.[1] ?? null;
}

export function encodeAnswerCode(parts: AnswerCodeParts): string {
	if (parts.vaultId.length === 0) throw new Error("vaultId is required");
	if (parts.offerId.length === 0) throw new Error("offerId is required");
	if (!parts.sdp.startsWith("v=")) throw new Error("sdp must start with 'v='");
	assertColonFree(parts.vaultId, "vaultId");
	assertColonFree(parts.offerId, "offerId");
	return `${SPIKE_ANSWER_PREFIX}:${parts.vaultId}:${parts.offerId}:${toB64UrlText(parts.sdp)}`;
}

export function decodeAnswerCode(code: string): DecodedAnswerCode | null {
	if (typeof code !== "string") return null;
	const trimmed = code.trim();
	if (!trimmed.startsWith(SPIKE_ANSWER_PREFIX + ":")) return null;
	const segments = trimmed.split(":");
	if (segments.length !== 4) return null;
	const [, vaultId, offerId, sdpB64] = segments;
	if (!vaultId || !offerId) return null;
	const sdp = fromB64UrlText(sdpB64 ?? "");
	if (sdp === null || !sdp.startsWith("v=")) return null;
	return {
		vaultId,
		offerId,
		sdp,
		charLength: trimmed.length,
		byteLength: new TextEncoder().encode(trimmed).length,
	};
}
