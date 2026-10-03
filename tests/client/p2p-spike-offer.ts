/**
 * Phase 0 spike — pairing code and SDP trimming (pure functions).
 *
 * Covers the T0.2 measurement surface: the code format, the trimmed offer,
 * and size accounting. No WebRTC is involved, so this runs in CI.
 */
import {
	countCandidateTypes,
	decodePairingCode,
	encodePairingCode,
	fromB64Url,
	fromB64UrlText,
	trimSdpForPairing,
	toB64Url,
	toB64UrlText,
} from "../../src/p2p/spikeOffer";
import { suite } from "../harness.ts";

const s = suite("p2p-spike-offer");

// A realistic Chromium data-channel offer with the junk lines a trimmer
// must drop (group, msid, ssrc, rtpmap, extmap, sendrecv, fingerprint kept).
const FULL_OFFER = [
	"v=0",
	"o=- 1513692685 2 IN IP4 127.0.0.1",
	"s=-",
	"t=0 0",
	"a=group:BUNDLE 0",
	"m=audio 9 UDP/TLS/RTP/SAVPF 0",
	"c=IN IP4 0.0.0.0",
	"a=rtpmap:0 PCMU/8000",
	"a=mid:0",
	"m=application 9 UDP/TLS/SCTP webrtc-datachannel",
	"c=IN IP4 192.168.1.42",
	"a=mid:1",
	"a=ice-ufrag:9B24",
	"a=ice-pwd:aa100c850117f47e4b4fc196",
	"a=ice-options:trickle",
	"a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55",
	"a=setup:actpass",
	"a=sendrecv",
	"a=msid:yaos-spike dc-1",
	"a=ssrc:12345 cname:rtc",
	"a=extmap:1 urn:ietf:params:rtp-hdrext:sent-time",
	"a=candidate:1 1 udp 2122260223 192.168.1.42 54321 typ host generation 0 ufrag 9B24 network-id 1",
	"a=candidate:2 1 udp 1694498815 203.0.113.7 54322 typ srflx raddr 192.168.1.42 rport 54321 generation 0 ufrag 9B24",
	"a=candidate:3 1 udp 184549375 198.51.100.9 54323 typ relay raddr 192.168.1.42 rport 54321 generation 0 ufrag 9B24",
	"a=end-of-candidates",
	"",
].join("\r\n");

s.section("b64url");
{
	s.check(fromB64UrlText(toB64UrlText("hello world")) === "hello world", "text round-trip");
	s.check(toB64UrlText("héllo 🌍") === "aMOpbGxvIPCfjI0", "unicode encodes (matches base64url)");
	s.check(fromB64UrlText("aMOpbGxvIPCfjI0") === "héllo 🌍", "unicode decodes");
	const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
	s.check(toB64Url(fromB64Url(toB64Url(bytes))) === toB64Url(bytes), "bytes round-trip");
	s.check(toB64Url(bytes) === "AAEC-vv8_f7_", "bytes match base64url");
	s.check(fromB64Url("no-such-!charset") === null, "bad alphabet rejected");
	s.check(fromB64Url("") === null, "empty rejected");
}

s.section("trim");
{
	const trimmed = trimSdpForPairing(FULL_OFFER);
	const lines = trimmed.split("\n");

	s.check(lines[0] === "v=0" && lines[1]!.startsWith("o=") && lines[2] === "s=-" && lines[3] === "t=0 0",
		"session header kept (v/o/s/t, in order)");
	s.check(lines.includes("m=application 9 UDP/TLS/SCTP webrtc-datachannel"),
		"data-channel m= line kept");
	s.check(!lines.some((l) => l.startsWith("m=audio")), "non-data-channel section dropped");
	s.check(!lines.some((l) => l.startsWith("a=group:")), "a=group dropped");
	s.check(!lines.some((l) => l.startsWith("a=msid:")), "a=msid dropped");
	s.check(!lines.some((l) => l.startsWith("a=ssrc:")), "a=ssrc dropped");
	s.check(!lines.some((l) => l.startsWith("a=rtpmap:")), "a=rtpmap dropped");
	s.check(!lines.some((l) => l.startsWith("a=extmap:")), "a=extmap dropped");
	s.check(!lines.some((l) => l.startsWith("a=sendrecv")), "a=sendrecv dropped");
	s.check(lines.includes("a=mid:1"), "data-channel a=mid kept");
	s.check(!lines.includes("a=mid:0"), "audio a=mid dropped");
	s.check(lines.includes("a=ice-ufrag:9B24") && lines.includes("a=ice-pwd:aa100c850117f47e4b4fc196"),
		"ICE credentials kept");
	s.check(lines.some((l) => l.startsWith("a=fingerprint:sha-256")), "DTLS fingerprint kept");
	s.check(lines.includes("a=setup:actpass"), "DTLS setup kept");
	s.check(lines.includes("a=ice-options:trickle"), "ice-options kept");

	const candidates = lines.filter((l) => l.startsWith("a=candidate:"));
	s.check(candidates.length === 3, "all three candidates kept");
	// Candidate id is the token after "a=candidate:" (index 0 of the
	// remainder) — the next token is the network foundation, not the id.
	const order = candidates.map((l) => l.slice("a=candidate:".length).split(" ")[0]!);
	s.check(JSON.stringify(order) === JSON.stringify(["1", "2", "3"]), "candidate order preserved");
	s.check(trimmed.endsWith("\n"), "trimmed output ends with newline");
	s.check(trimSdpForPairing(trimmed) === trimmed, "trim is idempotent");
	s.check(trimmed.length < FULL_OFFER.length, "trim actually shrank the offer");
}

s.section("candidate counting");
{
	const stats = countCandidateTypes(FULL_OFFER);
	s.check(stats.total === 3, "total = 3");
	s.check(stats.byType.host === 1 && stats.byType.srflx === 1 && stats.byType.relay === 1 && stats.byType.prflx === 0,
		"per-type counts");
	s.check(countCandidateTypes("").total === 0, "empty input → zero");
	s.check(countCandidateTypes("v=0\na=candidate:1 1 udp 1 1.2.3.4 9 typ bogus").total === 0,
		"unknown typ ignored");
}

s.section("code encode/decode");
{
	const sdp = trimSdpForPairing(FULL_OFFER);
	const code = encodePairingCode({ vaultId: "vault-abc", vaultSecret: "0123456789abcdef", sdp });
	s.check(code.startsWith("YAOS-P2P1:vault-abc:0123456789abcdef:"), "format: prefix:vaultId:secret:");
	s.check(code.split(":").length === 4, "exactly four colon-separated segments");

	const decoded = decodePairingCode(code);
	s.check(decoded !== null, "round-trip decodes");
	if (decoded) {
		s.check(decoded.vaultId === "vault-abc" && decoded.vaultSecret === "0123456789abcdef", "fields survive");
		s.check(decoded.sdp === sdp, "sdp survives byte-for-byte");
		s.check(decoded.version === 1, "version from prefix");
		s.check(decoded.charLength === code.length, "charLength is the code length");
		s.check(decoded.byteLength > 0 && decoded.byteLength <= decoded.charLength, "byteLength sane");
	}

	// T0.2 measurement sanity: a real offer (≈1 KB) must stay well under the
	// QR version-40 capacity so the code fits a scannable code.
	const realSize = decodePairingCode(
		encodePairingCode({ vaultId: "v".repeat(22), vaultSecret: "x".repeat(64), sdp }),
	);
	s.check((realSize?.byteLength ?? 99999) < 2500, `full code fits QR (got ${realSize?.byteLength} bytes)`);
}

s.section("code rejects");
{
	const goodSdp = trimSdpForPairing(FULL_OFFER);
	const goodCode = encodePairingCode({ vaultId: "v", vaultSecret: "s", sdp: goodSdp });
	s.check(decodePairingCode("") === null, "empty rejected");
	s.check(decodePairingCode("YAOS-P2P2:v:s:" + toB64UrlText(goodSdp)) === null, "wrong version rejected");
	s.check(decodePairingCode("YAOS-P2P1:v:s") === null, "three segments rejected");
	s.check(decodePairingCode(goodCode + ":extra") === null, "five segments rejected");
	s.check(decodePairingCode("YAOS-P2P1:v:s!!!!" + toB64UrlText(goodSdp)) === null, "bad b64 rejected");
	s.check(decodePairingCode(`YAOS-P2P1:v:s:${toB64UrlText("not-sdp")}`) === null, "non-SDP payload rejected");
	s.check(decodePairingCode("  " + goodCode + "  ") !== null, "surrounding whitespace tolerated");
	let threw = false;
	try {
		encodePairingCode({ vaultId: "a:b", vaultSecret: "s", sdp: goodSdp });
	} catch {
		threw = true;
	}
	s.check(threw, "colon in vaultId throws");
}

await s.done();
