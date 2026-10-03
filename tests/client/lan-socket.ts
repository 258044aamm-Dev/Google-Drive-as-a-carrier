/**
 * Local network carrier — the WebSocket codec and the secure connection.
 * The codec is our own (the `ws` package cannot be bundled into the plugin),
 * so it is checked against `ws` in both directions over real TLS.
 */
import * as https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { suite } from "../harness.ts";
import { certFor, sleep, waitFor } from "../mocks/lanRig";
import { LanFrameError, LanFrameParser, OP_BINARY, OP_CLOSE, OP_CONTINUATION, OP_PING, OP_TEXT, encodeClosePayload, encodeFrame } from "../../src/lan-carrier/lanFrames";
import { acceptLanUpgrade, connectLanSocket } from "../../src/lan-carrier/lanSocket";
import { fingerprintOfPem } from "../../src/lan-carrier/lanCert";

const s = suite("lan-socket");
const mask = Uint8Array.from([1, 2, 3, 4]);

function threw(run: () => unknown): LanFrameError | null {
	try {
		run();
		return null;
	} catch (err) {
		return err instanceof LanFrameError ? err : null;
	}
}

s.section("1: the codec round-trips every length class, byte by byte");
{
	for (const size of [0, 1, 125, 126, 127, 65_535, 65_536, 300_000]) {
		const payload = Buffer.alloc(size, 0xab);
		const frame = encodeFrame(OP_BINARY, payload, mask);
		const parser = new LanFrameParser(true, 1_000_000);
		const got: unknown[] = [];
		if (size <= 1000) {
			for (const byte of frame) got.push(...parser.push(Buffer.from([byte])));
		} else {
			got.push(...parser.push(frame));
		}
		const first = got[0] as { kind: string; data: Buffer } | undefined;
		s.check(got.length === 1 && first?.kind === "binary" && first.data.equals(payload), `${size} bytes`);
	}
	const parser = new LanFrameParser(false, 1000);
	const out = parser.push(Buffer.concat([encodeFrame(OP_TEXT, Buffer.from("héllo")), encodeFrame(OP_PING, Buffer.from("p"))]));
	s.check(out.length === 2 && out[0]?.kind === "text" && out[0].data === "héllo" && out[1]?.kind === "ping", "two frames in one chunk, utf-8 intact");
}

s.section("2: fragments are reassembled; bad frames are refused");
{
	const parser = new LanFrameParser(false, 1000);
	const first = Buffer.from(encodeFrame(OP_TEXT, Buffer.from("ab")));
	first[0] = (first[0] ?? 0) & 0x7f; // clear FIN
	const last = encodeFrame(OP_CONTINUATION, Buffer.from("cd"));
	const out = [...parser.push(first), ...parser.push(last)];
	s.check(out.length === 1 && out[0]?.kind === "text" && out[0].data === "abcd", "a fragmented text message arrives whole");

	s.check(threw(() => new LanFrameParser(true, 1000).push(encodeFrame(OP_TEXT, Buffer.from("x")))) !== null, "the server refuses an unmasked client frame");
	s.check(threw(() => new LanFrameParser(false, 1000).push(encodeFrame(OP_TEXT, Buffer.from("x"), mask))) !== null, "the client refuses a masked server frame");
	const reserved = Buffer.from(encodeFrame(OP_TEXT, Buffer.from("x")));
	reserved[0] = (reserved[0] ?? 0) | 0x40;
	s.check(threw(() => new LanFrameParser(false, 1000).push(reserved)) !== null, "reserved bits are refused");
	s.check(threw(() => new LanFrameParser(false, 10).push(encodeFrame(OP_BINARY, Buffer.alloc(11))))?.closeCode === 1009, "a message over the limit is refused with 1009 before it is read");
	s.check(threw(() => new LanFrameParser(false, 1000).push(encodeFrame(OP_PING, Buffer.alloc(126)))) !== null, "an oversized control frame is refused");
	s.check(threw(() => new LanFrameParser(false, 1000).push(Buffer.from([0x83, 0x00]))) !== null, "an unknown opcode is refused");
	s.check(threw(() => new LanFrameParser(false, 1000).push(encodeFrame(OP_CONTINUATION, Buffer.from("x")))) !== null, "a continuation without a start is refused");
	const huge = Buffer.alloc(10);
	huge[0] = 0x82;
	huge[1] = 127;
	huge.writeUInt32BE(0x40000000, 2);
	s.check(threw(() => new LanFrameParser(false, 1_000_000).push(huge))?.closeCode === 1009, "a 64-bit length beyond the limit is refused");
	const close = new LanFrameParser(false, 1000).push(encodeFrame(OP_CLOSE, encodeClosePayload(1008, "no")));
	s.check(close[0]?.kind === "close" && close[0].code === 1008 && close[0].reason === "no", "a close frame carries its code and reason");
}

s.section("3: our client talks to the `ws` server over TLS, and sees the certificate every time");
{
	const cert = certFor("interop");
	const server = https.createServer({ key: cert.keyPem, cert: cert.certPem });
	const wss = new WebSocketServer({ server });
	const seen: Array<{ binary: boolean; length: number }> = [];
	wss.on("connection", (ws) => {
		ws.on("message", (data: Buffer, isBinary: boolean) => {
			seen.push({ binary: isBinary, length: data.length });
			ws.send(data, { binary: isBinary });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	try {
		let allSeen = true;
		let allEcho = true;
		for (let i = 0; i < 6; i++) {
			const { socket, serverFingerprint } = await connectLanSocket({ host: "127.0.0.1", port, timeoutMs: 3000 });
			if (serverFingerprint !== cert.fingerprint) allSeen = false;
			const echoes: string[] = [];
			const bins: number[] = [];
			socket.attach({ onText: (t) => echoes.push(t), onBinary: (d) => bins.push(d.length), onClose: () => undefined });
			socket.sendText("hello ✓");
			socket.sendBinary(new Uint8Array(70_000));
			const ok = await waitFor(() => echoes.length === 1 && bins.length === 1);
			if (!ok || echoes[0] !== "hello ✓" || bins[0] !== 70_000) allEcho = false;
			socket.close(1000, "done");
		}
		s.check(allSeen, "six connections in a row each report the real fingerprint (no TLS session resumption)");
		s.check(allEcho, "text and 70 kB binary survive the round trip against ws");
		s.check(fingerprintOfPem(cert.certPem) === cert.fingerprint, "the fingerprint is the SHA-256 of the DER certificate");
	} finally {
		wss.close();
		server.close();
	}
}

s.section("4: the `ws` client talks to our server");
{
	const cert = certFor("interop2");
	const server = https.createServer({ key: cert.keyPem, cert: cert.certPem });
	const received: Array<string | number> = [];
	const closedWith: { value: { code: number; reason: string } | null } = { value: null };
	server.on("upgrade", (req, socket, head) => {
		const accepted = acceptLanUpgrade(req, socket as Socket, head);
		if (!accepted) return;
		accepted.attach({
			onText: (t) => { received.push(t); accepted.sendText(`echo:${t}`); },
			onBinary: (d) => { received.push(d.length); accepted.sendBinary(d); },
			onClose: (code, reason) => { closedWith.value = { code, reason }; },
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	try {
		const client = new WebSocket(`wss://127.0.0.1:${port}/yaos-lan`, { rejectUnauthorized: false });
		const back: Array<string | number> = [];
		client.on("message", (data: Buffer, isBinary: boolean) => back.push(isBinary ? data.length : data.toString()));
		await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
		client.send("one");
		client.send(Buffer.alloc(200_000, 1));
		client.send(Buffer.alloc(0), { binary: true });
		await waitFor(() => back.length === 3);
		s.check(back[0] === "echo:one" && back[1] === 200_000 && back[2] === 0, "text, 200 kB and empty binary come back");
		s.check(received.length === 3, "the server saw all three");
		client.close(1000, "bye");
		await waitFor(() => closedWith.value !== null);
		const closed = closedWith.value;
		s.check(closed?.code === 1000 && closed.reason === "bye", "a normal close reaches the server with its code");
	} finally {
		server.close();
	}
}

s.section("5: the server refuses things that are not a WebSocket upgrade for it");
{
	const cert = certFor("interop3");
	const server = https.createServer({ key: cert.keyPem, cert: cert.certPem }, (_req, res) => { res.writeHead(426); res.end(); });
	server.on("upgrade", (req, socket, head) => {
		if (!acceptLanUpgrade(req, socket as Socket, head)) return;
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	try {
		const status = await new Promise<number>((resolve) => {
			const req = https.request({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
			req.on("error", () => resolve(0));
			req.end();
		});
		s.check(status === 426, "a plain request is answered 426, not served");
		const bad = await new Promise<string>((resolve) => {
			const req = https.request({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false, agent: false, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13" } });
			req.on("upgrade", () => resolve("upgraded"));
			req.on("response", (res) => { res.resume(); resolve(`response ${res.statusCode ?? 0}`); });
			req.on("error", () => resolve("error"));
			req.end();
		});
		s.check(bad !== "upgraded", `an upgrade without a key is not accepted (${bad})`);
	} finally {
		server.close();
	}
}
await sleep(10);
await s.done();
