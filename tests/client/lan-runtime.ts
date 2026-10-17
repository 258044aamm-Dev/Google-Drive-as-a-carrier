/**
 * Local network carrier — the pieces main.ts uses, built from settings: two devices
 * set up from one setup code sync a document, an attachment and a restore point
 * over real secure links on loopback.
 */
import * as Y from "yjs";
import { suite } from "../harness.ts";
import { sleep, waitFor } from "../mocks/lanRig";
import { createLanCarrier, type LanCarrier } from "../../src/lan-carrier/lanCarrierRuntime";
import { MemoryFileStore, sha256Hex } from "../../src/lan-carrier/lanFileStore";
import { applyLanSetupCode, ensureLanIdentity, lanSetupCodeOf, type LanCarrierSettings } from "../../src/lan-carrier/lanSettings";
import type { SyncTransport } from "../../src/sync/transport";

const s = suite("lan-runtime");

type Settings = LanCarrierSettings & { deviceName: string; vaultId: string };

interface Device {
	settings: Settings;
	saves: string[];
	doc: Y.Doc;
	carrier: LanCarrier;
	blobs: MemoryFileStore;
	snaps: MemoryFileStore;
	problems: string[];
	transport: SyncTransport | null;
}

let counter = 0;
const rnd = (length: number): string => `${(counter++).toString(36)}q`.padEnd(length, "k");

function makeDevice(name: string, port: number, extra: Partial<Settings> = {}): Device {
	const settings: Settings = { deviceName: name, vaultId: "vault-one", lanPort: port, lanDiscoveryOff: true, ...extra };
	ensureLanIdentity(settings, name, rnd);
	const saves: string[] = [];
	const blobs = new MemoryFileStore();
	const snaps = new MemoryFileStore();
	const problems: string[] = [];
	const doc = new Y.Doc();
	const carrier = createLanCarrier({
		getSettings: () => settings,
		updateSettings: (mutator, reason) => { mutator(settings); saves.push(reason); return Promise.resolve(); },
		filesFor: (folder) => (folder === "blobs" ? blobs : snaps),
		log: () => {},
		onProblem: (m) => problems.push(m),
	});
	return { settings, saves, doc, carrier, blobs, snaps, problems, transport: null };
}

function start(d: Device): SyncTransport {
	d.transport = d.carrier.transportFactory({ doc: d.doc, vaultId: d.settings.vaultId, isLocalStoreOrigin: () => false });
	return d.transport;
}

const devices: Device[] = [];
const track = (d: Device): Device => { devices.push(d); return d; };
function stopAll(): void { for (const d of devices.splice(0)) (d.transport as { destroy?: () => void } | null)?.destroy?.(); }

try {
	s.section("1: a second device joins with the first one's setup code");
	const a = track(makeDevice("Laptop", 38871));
	const code = lanSetupCodeOf(a.settings);
	s.check(code !== null && /^YAOS-LAN1:vault-one:[0-9a-f]{64}$/.test(code), "the first device shows a setup code");
	const b = track(makeDevice("Desktop", 38872, { vaultId: "other-vault" }));
	s.check(applyLanSetupCode(b.settings, code ?? "") === null, "the second device accepts it");
	s.check(b.settings.vaultId === "vault-one" && b.settings.lanKey === a.settings.lanKey, "same vault, same key");
	s.check(b.settings.lanDeviceId !== a.settings.lanDeviceId && b.settings.lanCertPem !== a.settings.lanCertPem, "but its own device id and certificate");

	s.section("2: documents travel between them");
	a.doc.getText("t").insert(0, "written on the laptop");
	a.settings.lanManualPeers = "127.0.0.1:38872";
	const ta = start(a);
	const tb = start(b);
	await ta.connect();
	await tb.connect();
	s.check(a.carrier.status().running && a.carrier.status().listening && a.carrier.status().port === 38871, "the status shows the port it listens on");
	a.carrier.applyManualPeers();
	s.check(await waitFor(() => ta.synced && tb.synced, 8000), "both report synced");
	s.check(b.doc.getText("t").toString() === "written on the laptop", "history reached the second device");
	b.doc.getText("t").insert(0, "[desk] ");
	s.check(await waitFor(() => a.doc.getText("t").toString().startsWith("[desk] ")), "live edits travel back");
	const st = a.carrier.status();
	s.check(st.linked.length === 1 && st.linked[0]?.deviceName === "Desktop" && st.linked[0]?.synced === true, "the status lists the linked device");
	s.check(st.fingerprint.length > 0, "and the device's own fingerprint");

	s.section("3: the certificate is remembered through the settings");
	// The device that dials remembers the certificate it met; the one that is dialled has nothing to check against yet.
	s.check(a.saves.includes("settings:lan-pin") && Object.keys(a.settings.lanPins ?? {}).join() === b.settings.lanDeviceId, "the device that dialled saved the other's fingerprint, keyed by its id");
	s.check((a.settings.lanPins?.[b.settings.lanDeviceId ?? ""] ?? "").length > 20, "it is a real fingerprint");
	s.check(!b.saves.includes("settings:lan-pin"), "the device that was dialled saved nothing");

	s.section("4: attachments and restore points");
	const data = new TextEncoder().encode("an attachment over the local network");
	const hash = await sha256Hex(data);
	const storeA = a.carrier.blobStore("vault-one");
	const storeB = b.carrier.blobStore("vault-one");
	s.check(a.carrier.blobStore("vault-one") === storeA, "one attachment store per device");
	const copy = new Uint8Array(data.byteLength); copy.set(data);
	await storeA.upload(hash, "text/plain", copy.buffer, 2000);
	s.check(new TextDecoder().decode(await storeB.download(hash, 4000)) === "an attachment over the local network", "the other device fetches it");
	s.check(await b.blobs.exists(hash), "and keeps its own verified copy");

	const backend = a.carrier.snapshotBackend("vault-one", () => a.doc);
	s.check(a.carrier.snapshotBackend("vault-one", () => a.doc) === backend, "one snapshot backend per device");
	a.doc.getMap<string>("pathToId").set("n.md", "id-n");
	const made = await backend.now("laptop");
	s.check(made.status === "created", "a restore point can be made");
	s.check((await backend.list()).length === 1 && (await b.carrier.snapshotBackend("vault-one", () => b.doc).list()).length === 0, "and it stays on the device that made it");

	s.section("5: a wrong key is refused, and says so");
	const c = track(makeDevice("Stranger", 38873));
	b.settings.lanManualPeers = "127.0.0.1:38873";
	c.settings.lanManualPeers = "127.0.0.1:38871";
	const tc = start(c);
	await tc.connect();
	c.carrier.applyManualPeers();
	b.carrier.applyManualPeers();
	await sleep(1500);
	s.check(!tc.synced && c.doc.getText("t").toString() === "", "the stranger gets nothing");
	s.check(a.carrier.status().refusals.length > 0 || c.carrier.status().refusals.length > 0, "a refusal is recorded");
	s.check(a.carrier.status().linked.every((l) => l.deviceName !== "Stranger"), "and is not listed as linked");

	s.section("6: stopping");
	stopAll();
	await sleep(100);
	s.check(!a.carrier.status().listening || a.carrier.status().running, "no crash after stop");
} finally {
	stopAll();
}
await s.done();
