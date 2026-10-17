/**
 * Local network carrier — the link layer over real sockets on loopback:
 * secure connection, key-bound sign-in, pinning, lockout, duplicate links,
 * discovery, reconnects.
 */
import { suite } from "../harness.ts";
import { certFor, generateLanKey, makeDevice, sleep, waitFor, type RigDevice } from "../mocks/lanRig";
import { generateLanCert } from "../../src/lan-carrier/lanCert";
import { connectLanSocket } from "../../src/lan-carrier/lanSocket";
import { encodeLanText, lanHello, parseLanText } from "../../src/lan-carrier/lanProtocol";
import { randomNonce } from "../../src/lan-carrier/lanAuth";
import { vaultTag } from "../../src/lan-carrier/lanDiscovery";

const s = suite("lan-hub");
const key = generateLanKey();
const devices: RigDevice[] = [];
const track = (d: RigDevice): RigDevice => { devices.push(d); return d; };

async function pair(aOpts: Record<string, unknown> = {}, bOpts: Record<string, unknown> = {}) {
	const a = track(makeDevice({ id: "dev-a", key, ...aOpts }));
	await a.hub.start();
	const port = a.hub.status().port;
	const b = track(makeDevice({ id: "dev-b", key, manualPeers: [`127.0.0.1:${port}`], ...bOpts }));
	await b.hub.start();
	return { a, b, port };
}

try {
	s.section("1: two devices link through a typed-in address");
	{
		const { a, b } = await pair();
		const ok = await waitFor(() => a.ready.length === 1 && b.ready.length === 1);
		s.check(ok, "both ends report a signed-in link");
		s.check(a.ready[0]?.deviceId === "dev-b" && b.ready[0]?.deviceId === "dev-a", "each side knows who the other is");
		s.check(b.ready[0]?.direction === "out" && a.ready[0]?.direction === "in", "the dialler has the outgoing link, the server the incoming one");
		s.check(b.pins.get("dev-a") === a.cert.fingerprint, "the server's certificate fingerprint is pinned after the first sign-in");

		const gotA: string[] = [];
		const gotB: number[] = [];
		a.ready[0]?.setHandlers({ onText: (m) => { if (m.t === "ack") gotA.push(m.sv); }, onBinary: () => undefined, onClose: () => undefined });
		b.ready[0]?.setHandlers({ onText: () => undefined, onBinary: (d) => { gotB.push(d.length); }, onClose: () => undefined });
		b.ready[0]?.sendText({ t: "ack", sv: "AAA=" });
		a.ready[0]?.sendBinary(new Uint8Array(200_000).fill(7));
		await waitFor(() => gotA.length === 1 && gotB.length === 1);
		s.check(gotA[0] === "AAA=", "a text message crosses the link");
		s.check(gotB[0] === 200_000, "a 200 kB binary message crosses the link in one piece");
		s.check(a.hub.status().links.length === 1 && b.hub.status().links.length === 1, "status lists the link on both sides");
		for (const d of devices.splice(0)) d.hub.stop();
	}

	s.section("2: a dialler with the wrong key is refused; guessing at the server locks the address out");
	{
		const a = track(makeDevice({ id: "dev-a", key }));
		await a.hub.start();
		const port = a.hub.status().port ?? 0;
		const b = track(makeDevice({ id: "dev-b", key: generateLanKey(), manualPeers: [`127.0.0.1:${port}`], reconnectBaseMs: 10, reconnectMaxMs: 20 }));
		await b.hub.start();
		await waitFor(() => b.hub.status().refusals.length > 0, 3000);
		s.check(a.ready.length === 0 && b.ready.length === 0, "no link was made with a different key");
		s.check(b.hub.status().refusals.length > 0, "the dialler records why it refused");
		b.hub.stop();

		// A raw attacker that skips verifying the server and just guesses at the sign-in.
		const attempt = async (): Promise<string> => {
			let socket;
			try {
				({ socket } = await connectLanSocket({ host: "127.0.0.1", port, timeoutMs: 2000 }));
			} catch {
				return "connection dropped";
			}
			return await new Promise<string>((resolve) => {
				const timer = setTimeout(() => resolve("timeout"), 2000);
				socket.attach({
					onText: (text) => {
						const m = parseLanText(text);
						if (m?.t === "challenge") socket.sendText(encodeLanText({ t: "auth", proof: "00".repeat(32) }));
						if (m?.t === "refuse") { clearTimeout(timer); resolve(m.reason); }
					},
					onBinary: () => undefined,
					onClose: (_c, reason) => { clearTimeout(timer); resolve(`closed:${reason}`); },
					onPong: () => undefined,
				});
				socket.sendText(encodeLanText(lanHello("attacker", "Attacker", vaultTag("vault-test"), randomNonce())));
			});
		};
		const reasons: string[] = [];
		for (let i = 0; i < 6; i++) reasons.push(await attempt());
		s.check(reasons.slice(0, 5).every((r) => r === "wrong key"), `the first five bad guesses get wrong key (${JSON.stringify(reasons)})`);
		s.check(reasons[5] === "connection dropped", `the sixth attempt is dropped before it starts (${reasons[5]})`);
		s.check(a.hub.status().refusals.some((r) => /locked out/.test(r.reason)), "the owner is told the address was locked out");
		s.check(a.ready.length === 0, "the attacker never got in");
		for (const d of devices.splice(0)) d.hub.stop();
	}

	s.section("3: a server that does not know the key is refused by the dialler (mutual sign-in)");
	{
		const rogue = track(makeDevice({ id: "dev-r", key: generateLanKey() }));
		await rogue.hub.start();
		const honest = track(makeDevice({ id: "dev-h", key, manualPeers: [`127.0.0.1:${rogue.hub.status().port}`], reconnectBaseMs: 10, reconnectMaxMs: 20 }));
		await honest.hub.start();
		await waitFor(() => honest.hub.status().refusals.length > 0, 3000);
		s.check(honest.ready.length === 0 && rogue.ready.length === 0, "no link with a server that cannot prove the key");
		s.check(/does not know this key|tampered/.test(honest.hub.status().refusals[0]?.reason ?? ""), "the reason names the key / tampering");
		for (const d of devices.splice(0)) d.hub.stop();
	}

	s.section("4: a changed certificate for a known device is refused (pinning)");
	{
		const pins = new Map<string, string>();
		const a1 = track(makeDevice({ id: "dev-a", key }));
		await a1.hub.start();
		const port = a1.hub.status().port ?? 0;
		const b = track(makeDevice({ id: "dev-b", key, pins, manualPeers: [`127.0.0.1:${port}`] }));
		await b.hub.start();
		await waitFor(() => b.ready.length === 1);
		s.check(pins.size === 1, "first contact is pinned");
		a1.hub.stop();
		b.hub.stop();
		// Same device id and key, brand-new certificate (e.g. a reinstall).
		const a2 = track(makeDevice({ id: "dev-a", key, cert: generateLanCert("other"), port }));
		await a2.hub.start();
		const b2 = track(makeDevice({ id: "dev-b", key, pins, manualPeers: [`127.0.0.1:${a2.hub.status().port}`], reconnectBaseMs: 10, reconnectMaxMs: 20 }));
		await b2.hub.start();
		await waitFor(() => b2.hub.status().refusals.length > 0, 3000);
		s.check(b2.ready.length === 0, "no link with a different certificate than the pinned one");
		s.check(/different certificate/.test(b2.hub.status().refusals[0]?.reason ?? ""), "the refusal explains it and how to fix it");
		pins.clear();
		await waitFor(() => b2.ready.length === 1, 3000);
		s.check(b2.ready.length === 1, "after the pin is forgotten the link is made");
		for (const d of devices.splice(0)) d.hub.stop();
	}

	s.section("5: no key at all means the hub does not start");
	{
		const d = track(makeDevice({ id: "dev-x", key: "" }));
		await d.hub.start();
		s.check(d.hub.status().listening === false && /pairing key/.test(d.hub.status().error ?? ""), "an empty key is refused with a clear message");
		const short = track(makeDevice({ id: "dev-y", key: "default-key" }));
		await short.hub.start();
		s.check(short.hub.status().listening === false, "the old built-in 'default-key' (and any short key) is refused");
		for (const x of devices.splice(0)) x.hub.stop();
	}

	s.section("6: two devices dialling each other keep exactly one link, the same one on both sides");
	{
		const a = track(makeDevice({ id: "dev-a", key }));
		const b = track(makeDevice({ id: "dev-b", key }));
		await a.hub.start();
		await b.hub.start();
		a.hub.setManualPeers([`127.0.0.1:${b.hub.status().port}`]);
		b.hub.setManualPeers([`127.0.0.1:${a.hub.status().port}`]);
		await waitFor(() => a.hub.links().length === 1 && b.hub.links().length === 1, 3000);
		await sleep(600);
		const la = a.hub.links();
		const lb = b.hub.links();
		s.check(la.length === 1 && lb.length === 1, "one link on each side after the race");
		// The surviving link was opened by the smaller id ("dev-a"): outgoing on a, incoming on b.
		s.check(la[0]?.direction === "out" && lb[0]?.direction === "in", "both sides kept the link opened by the device with the smaller id");
		s.check(!la[0]?.isClosed && !lb[0]?.isClosed, "and it is open");
		for (const d of devices.splice(0)) d.hub.stop();
	}

	s.section("7: a restart heals by itself (reconnect with back-off)");
	{
		const a = track(makeDevice({ id: "dev-a", key }));
		await a.hub.start();
		const port = a.hub.status().port ?? 0;
		const b = track(makeDevice({ id: "dev-b", key, manualPeers: [`127.0.0.1:${port}`] }));
		await b.hub.start();
		await waitFor(() => b.ready.length === 1);
		let closedReason = "";
		b.ready[0]?.setHandlers({ onText: () => undefined, onBinary: () => undefined, onClose: (r) => { closedReason = r; } });
		a.hub.stop();
		await waitFor(() => b.hub.links().length === 0, 3000);
		s.check(b.hub.links().length === 0 && closedReason !== "", "the dialler notices the other device going away");
		const a2 = track(makeDevice({ id: "dev-a", key, port }));
		await a2.hub.start();
		const relinked = await waitFor(() => b.ready.length === 2 && a2.ready.length === 1, 6000);
		s.check(relinked, "when the other device is back, the link is rebuilt without any action");
		for (const d of devices.splice(0)) d.hub.stop();
	}

	s.section("8: discovery finds a device without any typed-in address");
	{
		const a = track(makeDevice({ id: "dev-a", key, discoveryEnabled: true, discoveryPort: 38931, discoveryTargets: [{ address: "127.0.0.1", port: 38932 }] }));
		const b = track(makeDevice({ id: "dev-b", key, discoveryEnabled: true, discoveryPort: 38932, discoveryTargets: [{ address: "127.0.0.1", port: 38931 }] }));
		await a.hub.start();
		await b.hub.start();
		const ok = await waitFor(() => a.ready.length >= 1 && b.ready.length >= 1, 8000);
		s.check(ok, "the devices linked from announcements alone");
		s.check(a.hub.links().length === 1 && b.hub.links().length === 1, "exactly one link each");
		for (const d of devices.splice(0)) d.hub.stop();
	}

	s.section("9: a device of another vault is not linked");
	{
		const a = track(makeDevice({ id: "dev-a", key, vaultId: "vault-one" }));
		await a.hub.start();
		const b = track(makeDevice({ id: "dev-b", key, vaultId: "vault-two", manualPeers: [`127.0.0.1:${a.hub.status().port}`], reconnectBaseMs: 10, reconnectMaxMs: 20 }));
		await b.hub.start();
		await waitFor(() => a.hub.status().refusals.length > 0, 3000);
		s.check(a.ready.length === 0 && b.ready.length === 0, "different vault, no link");
		s.check(a.hub.status().refusals[0]?.reason === "a different vault", "the refusal says why");
		for (const d of devices.splice(0)) d.hub.stop();
	}

	s.section("10: stop() closes everything and frees the port");
	{
		const a = track(makeDevice({ id: "dev-a", key }));
		await a.hub.start();
		const port = a.hub.status().port ?? 0;
		const b = track(makeDevice({ id: "dev-b", key, manualPeers: [`127.0.0.1:${port}`] }));
		await b.hub.start();
		await waitFor(() => a.hub.links().length === 1);
		a.hub.stop();
		s.check(a.hub.links().length === 0 && a.hub.status().listening === false, "a stopped hub has no links and is not listening");
		const again = track(makeDevice({ id: "dev-c", key, port }));
		await again.hub.start();
		s.check(again.hub.status().listening === true, "its port can be bound again at once");
		for (const d of devices.splice(0)) d.hub.stop();
	}
} finally {
	for (const d of devices.splice(0)) d.hub.stop();
}
void certFor;
await s.done();
