import assert from "node:assert/strict";
import * as Y from "yjs";
import { suite } from "../harness.ts";
import { FakeDrive } from "../mocks/fakeDrive";
import { restoreFromSnapshot } from "../../src/sync/snapshotClient";
import { createNestedActiveMeta, getMetaPath } from "../../src/sync/fileMeta";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { DriveKeyring } from "../../src/drive-carrier/driveKeyring";
import { DriveSnapshotBackend } from "../../src/drive-carrier/driveSnapshotBackend";
import { HostedTokenManager, HostedAuthError } from "../../src/drive-carrier/hostedAuth";
import { GoogleDriveRest } from "../../src/drive-carrier/googleDriveRest";
import { explainSetupError } from "../../src/drive-carrier/wizard/explainError";
import { verifyProof, computeProof, generateLanKey, randomNonce } from "../../src/lan-carrier/lanAuth";
import { MemoryFileStore } from "../../src/lan-carrier/lanFileStore";
import { LanSnapshotBackend } from "../../src/lan-carrier/lanSnapshotBackend";

import { makeDevice, waitFor } from "../mocks/lanRig";
import { connectLanSocket, type LanSocket } from "../../src/lan-carrier/lanSocket";
import { encodeLanText, parseLanText, lanHello } from "../../src/lan-carrier/lanProtocol";
import { vaultTag } from "../../src/lan-carrier/lanDiscovery";
import { createLanCarrier } from "../../src/lan-carrier/lanCarrierRuntime";

const s = suite("branch-review-regressions");
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
function gate(): { promise: Promise<void>; release: () => void } {
	let release = () => {};
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}
function transport(doc: Y.Doc, drive: FakeDrive, id: string, timeout = 5000): DriveTransport {
	return new DriveTransport(doc, drive.client(), { vaultId: "review-vault", deviceId: id, autoTimers: false, cycleTimeoutMs: timeout });
}

s.test("R1: restoring old A preserves the active renamed B and gives A a separate identity", () => {
	const snapshot = new Y.Doc();
	const live = new Y.Doc();
	try {
		snapshot.getMap("sys").set("schemaVersion", 3);
		snapshot.getMap("meta").set("file1", createNestedActiveMeta("A.md", 1, "test"));
		snapshot.getMap("idToText").set("file1", new Y.Text("snapshot A"));
		Y.applyUpdate(live, Y.encodeStateAsUpdate(snapshot));
		live.getMap<Y.Map<unknown>>("meta").get("file1")?.set("path", "B.md");
		const text = live.getMap<Y.Text>("idToText").get("file1")!;
		text.delete(0, text.length); text.insert(0, "current B");
		restoreFromSnapshot(snapshot, live, { markdownPaths: ["A.md"], blobPaths: [], device: "test" });
		assert.equal(getMetaPath(live.getMap("meta").get("file1")), "B.md");
		assert.equal(text.toString(), "current B");
		const restoredId = [...live.getMap("meta").entries()].find(([, value]) => getMetaPath(value) === "A.md")?.[0];
		assert(restoredId && restoredId !== "file1");
		assert.equal(live.getMap<Y.Text>("idToText").get(restoredId)?.toString(), "snapshot A");
	} finally { snapshot.destroy(); live.destroy(); }
});

s.test("R2: corrupt-only Drive never reports synced, and repairing the same file recovers", async () => {
	const drive = new FakeDrive(); const aDoc = new Y.Doc(); const bDoc = new Y.Doc();
	const a = transport(aDoc, drive, "A"); const b = transport(bDoc, drive, "B");
	try {
		await a.connect(); aDoc.getText("note").insert(0, "remote only"); await a.flush();
		const file = [...drive.files.values()].find((f) => f.name.startsWith("seg-"))!;
		const good = new Uint8Array(file.data); file.data = new Uint8Array([1, 2, 3]);
		await b.connect();
		assert.equal(b.unreadableFiles, 1); assert.equal(b.synced, false); assert(b.lastError);
		file.data = good;
		await b.syncNow();
		assert.equal(b.unreadableFiles, 0); assert.equal(b.synced, true);
		assert.equal(bDoc.getText("note").toString(), "remote only");
	} finally { a.destroy(); b.destroy(); aDoc.destroy(); bDoc.destroy(); }
});

s.test("R3: malformed proofs fail closed without exceptions; valid proofs stay compatible", () => {
	const args = ["a".repeat(64), "client", "nc", "ns", "fp"] as const;
	for (const input of ["é".repeat(64), "\ud800".repeat(64), "z".repeat(64), "short", null, 5]) {
		assert.equal(verifyProof(...args, input), false);
	}
	assert.equal(verifyProof(...args, computeProof(...args)), true);
});

s.test("R4: a late read after timeout and destroy cannot mutate the document", async () => {
	const drive = new FakeDrive(); const remote = new Y.Doc(); const local = new Y.Doc();
	const a = transport(remote, drive, "seed"); const b = transport(local, drive, "late", 25);
	const held = gate();
	try {
		await a.connect(); remote.getText("note").insert(0, "late update"); await a.flush();
		let reads = 0;
		drive.latencyHook = async (op) => { if (op === "readFile" && ++reads === 2) await held.promise; };
		await b.connect(); assert.match(b.lastError ?? "", /Timeout/);
		b.destroy(); held.release(); await wait(40);
		assert.equal(local.getText("note").toString(), "");
		assert.equal(b.synced, false); assert.equal(b.wsconnected, false);
	} finally { held.release(); a.destroy(); b.destroy(); remote.destroy(); local.destroy(); }
});

s.test("R4: a hung explicit flush is bounded, preserves edits and does not block the next cycle", async () => {
	const drive = new FakeDrive(); const doc = new Y.Doc(); const t = transport(doc, drive, "A", 25); const held = gate();
	try {
		await t.connect(); doc.getText("note").insert(0, "preserve me");
		let paused = false;
		drive.latencyHook = async (op) => { if (op === "createFile" && !paused) { paused = true; await held.promise; } };
		const flushing = t.flush().then(() => "ok", () => "rejected");
		await wait(5);
		const next = t.syncNow();
		const outcome = await Promise.race([next.then(() => "completed"), wait(250).then(() => "blocked")]);
		assert.equal(outcome, "completed"); assert.equal(await flushing, "rejected");
		held.release(); await wait(20); await t.syncNow();
		assert.equal(t.pendingParts, 0);
		const restored = new Y.Doc(); const r = transport(restored, drive, "reader");
		try { await r.connect(); assert.equal(restored.getText("note").toString(), "preserve me"); }
		finally { r.destroy(); restored.destroy(); }
	} finally { held.release(); t.destroy(); doc.destroy(); }
});

s.test("R5: swapping valid encrypted snapshot bytes is rejected against the selected index", async () => {
	const drive = new FakeDrive(); const api = drive.client(); const doc = new Y.Doc(); let now = 1000000;
	try {
		const keyring = new DriveKeyring(api, { vaultId: "snap-vault", passphrase: "test passphrase", kdfIterations: 1000 });
		const store = new DriveSnapshotBackend(api, { vaultId: "snap-vault", getDoc: () => doc, keyring, now: () => now, random: () => String(now) });
		doc.getText("note").insert(0, "version A"); const a = await store.now(); now += 1000;
		doc.getText("note").insert(0, "B "); const b = await store.now();
		assert(a.index && b.index);
		const fileA = [...drive.files.values()].find((f) => f.name === `snapdat-${a.snapshotId}.bin`)!;
		const fileB = [...drive.files.values()].find((f) => f.name === `snapdat-${b.snapshotId}.bin`)!;
		fileA.data = new Uint8Array(fileB.data);
		await assert.rejects(() => store.download(a.index!), /integrity|size|hash/i);
		const correct = await store.download(b.index); correct.destroy();
	} finally { doc.destroy(); }
});

s.test("R6: shared LAN storage isolates listing, daily creation, download and prune by vault", async () => {
	const files = new MemoryFileStore(); const aDoc = new Y.Doc(); const bDoc = new Y.Doc();
	try {
		aDoc.getText("note").insert(0, "vault A"); bDoc.getText("note").insert(0, "vault B");
		const a = new LanSnapshotBackend(files, { vaultId: "A", getDoc: () => aDoc, now: () => 1000000, random: () => "same" });
		const b = new LanSnapshotBackend(files, { vaultId: "B", getDoc: () => bDoc, now: () => 1000000, random: () => "same" });
		const old = await a.now(); assert(old.index);
		assert.deepEqual(await b.list(), []);
		await assert.rejects(() => b.download(old.index!), /vault/i);
		const fresh = await b.daily(); assert.equal(fresh.status, "created"); assert.notEqual(fresh.snapshotId, old.snapshotId);
		await b.prune(); assert.equal((await a.list()).length, 1);
		const restored = await a.download(old.index); assert.equal(restored.getText("note").toString(), "vault A"); restored.destroy();
	} finally { aDoc.destroy(); bDoc.destroy(); }
});

s.test("R7: hosted configuration errors survive Drive REST wrapping without credential leakage", async () => {
	const secret = "synthetic-never-log-me";
	const manager = new HostedTokenManager(async () => ({ status: 400, body: new TextEncoder().encode(JSON.stringify({ error: "invalid_client", error_description: secret })) }), "https://example.invalid", secret);
	const api = new GoogleDriveRest(async () => { throw new Error("Drive must not be contacted"); }, manager.provider);
	await assert.rejects(() => api.findFolders("test"), (err: unknown) => {
		assert(err instanceof HostedAuthError); assert.equal(err.code, "invalid_client");
		assert.match(explainSetupError(err), /configuration problem/); assert(!explainSetupError(err).includes(secret));
		return true;
	});
});

s.test("R1: legacy rename is isolated and ordinary undelete retains its original ID", () => {
	for (const renamed of [false, true]) {
		const snapshot = new Y.Doc(); const live = new Y.Doc();
		try {
			snapshot.getMap("pathToId").set("A.md", "original");
			snapshot.getMap("idToText").set("original", new Y.Text("old"));
			Y.applyUpdate(live, Y.encodeStateAsUpdate(snapshot));
			live.getMap("pathToId").delete("A.md");
			if (renamed) live.getMap("pathToId").set("B.md", "original");
			const original = live.getMap<Y.Text>("idToText").get("original")!;
			original.insert(0, "new ");
			restoreFromSnapshot(snapshot, live, { markdownPaths: ["A.md"], blobPaths: [], device: "test" });
			const id = live.getMap<string>("pathToId").get("A.md")!;
			assert.equal(id === "original", !renamed);
			assert.equal(live.getMap<Y.Text>("idToText").get(id)?.toString(), "old");
			if (renamed) assert.equal(original.toString(), "new old");
			const count = live.getMap("idToText").size;
			restoreFromSnapshot(snapshot, live, { markdownPaths: ["A.md"], blobPaths: [], device: "test" });
			assert.equal(live.getMap("idToText").size, count);
		} finally { snapshot.destroy(); live.destroy(); }
	}
});

s.test("R2: a newly discovered damaged file demotes an already-synced reader and blocks complete receipts", async () => {
	const drive = new FakeDrive(); const doc = new Y.Doc(); const t = transport(doc, drive, "reader");
	try {
		await t.connect(); assert(t.synced);
		const folder = [...drive.folders.values()][0]!;
		await drive.client().createFile(folder.id, "seg-0000000000001-broken-000000.ydu", new Uint8Array([1]));
		let receipts = 0; t.on("custom-message", () => { receipts++; });
		await t.syncNow(); assert.equal(t.synced, false); assert.equal(t.unreadableFiles, 1); assert.equal(receipts, 0);
		drive.remove("seg-0000000000001-broken-000000.ydu");
		await t.syncNow(); assert(t.synced);
	} finally { t.destroy(); doc.destroy(); }
});

s.test("R3: malformed proof over real loopback TLS is refused; a valid peer still joins", async () => {
	const key = generateLanKey(); const server = makeDevice({ id: "review-server", key });
	const peer = makeDevice({ id: "review-peer", key });
	let socket: LanSocket | null = null;
	try {
		await server.hub.start(); const port = server.hub.status().port!;
		({ socket } = await connectLanSocket({ host: "127.0.0.1", port, timeoutMs: 2000 }));
		const raw = socket; let refused = false;
		raw.attach({ onText: (text) => {
			const m = parseLanText(text);
			if (m?.t === "challenge") raw.sendText(encodeLanText({ t: "auth", proof: "é".repeat(64) }));
			if (m?.t === "refuse") refused = true;
		}, onBinary: () => undefined, onClose: () => undefined });
		raw.sendText(encodeLanText(lanHello("malformed", "Malformed", vaultTag("vault-test"), randomNonce())));
		assert(await waitFor(() => refused, 2000)); assert.equal(server.ready.length, 0);
		peer.hub.setManualPeers([`127.0.0.1:${port}`]); await peer.hub.start();
		assert(await waitFor(() => server.ready.length === 1 && peer.ready.length === 1));
	} finally { socket?.terminate(); server.hub.stop(); peer.hub.stop(); }
});

s.test("R4: disconnect fences an old read before a new session reconnects", async () => {
	const drive = new FakeDrive(); const remote = new Y.Doc(); const local = new Y.Doc(); const held = gate();
	const a = transport(remote, drive, "seed"); const b = transport(local, drive, "reader", 5000);
	try {
		await a.connect(); remote.getText("note").insert(0, "remote"); await a.flush();
		let reads = 0; let started = false;
		drive.latencyHook = async (op) => { if (op === "readFile" && ++reads === 2) { started = true; await held.promise; } };
		const old = b.connect(); assert(await waitFor(() => started));
		b.disconnect(); await old;
		assert.equal(local.getText("note").toString(), ""); assert.equal(b.wsconnected, false);
		drive.latencyHook = null; await b.connect();
		assert(b.synced); assert.equal(local.getText("note").toString(), "remote");
		held.release(); await wait(20); assert(b.synced); assert.equal(local.getText("note").toString(), "remote");
	} finally { held.release(); a.destroy(); b.destroy(); remote.destroy(); local.destroy(); }
});

s.test("R4: a cancelled metadata read cannot create metadata or initialize its keyring later", async () => {
	const drive = new FakeDrive(); const doc = new Y.Doc(); const held = gate();
	const ring = new DriveKeyring(drive.client(), { vaultId: "meta-vault", passphrase: "secret", kdfIterations: 1000 });
	const t = new DriveTransport(doc, drive.client(), { vaultId: "meta-vault", deviceId: "A", autoTimers: false, cycleTimeoutMs: 25, keyring: ring });
	try {
		let once = false; drive.latencyHook = async (op) => { if (op === "listFiles" && !once) { once = true; await held.promise; } };
		await t.connect(); t.destroy(); held.release(); await wait(40);
		assert.equal(ring.isReady, false); assert.equal(drive.calls.createFile, 0);
	} finally { held.release(); t.destroy(); doc.destroy(); }
});

s.test("R4: late upload completion emits no stale receipt and shutdown still sends a detached final batch", async () => {
	const drive = new FakeDrive(); const doc = new Y.Doc(); const t = transport(doc, drive, "A", 25); const held = gate();
	try {
		await t.connect(); doc.getText("note").insert(0, "shutdown content");
		let once = false; drive.latencyHook = async (op) => { if (op === "createFile" && !once) { once = true; await held.promise; } };
		await assert.rejects(() => t.flush(), /Timeout/);
		let receipts = 0; t.on("custom-message", () => { receipts++; });
		t.destroy(); const pending = t.pendingParts; held.release(); await wait(40);
		assert.equal(receipts, 0); assert.equal(t.pendingParts, pending); assert.equal(t.synced, false);
		const back = new Y.Doc(); const reader = transport(back, drive, "reader");
		try { await reader.connect(); assert.equal(back.getText("note").toString(), "shutdown content"); }
		finally { reader.destroy(); back.destroy(); }
	} finally { held.release(); t.destroy(); doc.destroy(); }
});

s.test("R5: LAN restore checks hash, vault, missing integrity metadata and bounded decompression", async () => {
	const files = new MemoryFileStore(); const doc = new Y.Doc();
	try {
		doc.getText("note").insert(0, "valid");
		const store = new LanSnapshotBackend(files, { vaultId: "A", getDoc: () => doc });
		const snapshot = await store.now(); assert(snapshot.index);
		const index = snapshot.index;
		await assert.rejects(() => store.download({ ...index, fullUpdateHash: "0".repeat(64) }), /hash/);
		await assert.rejects(() => store.download({ ...index, fullUpdateHash: undefined }), /hash/);
		await assert.rejects(() => store.download({ ...index, vaultId: "B" }), /vault/);
		await assert.rejects(() => store.download({ ...index, crdtRawSizeBytes: Number.MAX_SAFE_INTEGER }), /size/);
		await assert.rejects(() => store.download({ ...index, crdtRawSizeBytes: 1 }), /size/);
		const back = await store.download(index); assert.equal(back.getText("note").toString(), "valid"); back.destroy();
	} finally { doc.destroy(); }
});

s.test("R6: legacy timestamp-only snapshots remain readable only by their own vault", async () => {
	const files = new MemoryFileStore(); const doc = new Y.Doc();
	try {
		const a = new LanSnapshotBackend(files, { vaultId: "A", getDoc: () => doc });
		const current = await a.now(); assert(current.index);
		const data = await files.read(`snapdat-${current.snapshotId}.bin`); assert(data);
		const legacy = { ...current.index, snapshotId: "0000001000000-old" };
		await files.remove(`snapdat-${current.snapshotId}.bin`); await files.remove(`snapidx-${current.snapshotId}.json`);
		await files.write(`snapdat-${legacy.snapshotId}.bin`, data);
		await files.write(`snapidx-${legacy.snapshotId}.json`, new TextEncoder().encode(JSON.stringify(legacy)));
		assert.equal((await a.list())[0]?.snapshotId, legacy.snapshotId);
		const back = await a.download(legacy); back.destroy();
		const b = new LanSnapshotBackend(files, { vaultId: "B", getDoc: () => doc });
		assert.deepEqual(await b.list(), []);
		await assert.rejects(() => b.download({ ...legacy, vaultId: "B" }), /vault/);
		await b.prune(); assert(await files.exists(`snapdat-${legacy.snapshotId}.bin`));
	} finally { doc.destroy(); }
});

s.test("R6: pruning B never removes A's snapshots; runtime caches each vault separately", async () => {
	const files = new MemoryFileStore(); const doc = new Y.Doc(); let now = 1000000;
	try {
		const a = new LanSnapshotBackend(files, { vaultId: "A", getDoc: () => doc, now: () => now });
		const b = new LanSnapshotBackend(files, { vaultId: "B", getDoc: () => doc, now: () => now });
		for (let i = 0; i < 16; i++) { now += 86400000; await a.daily(); await b.daily(); }
		assert.equal((await b.prune()).pruned, 2); assert.equal((await a.list()).length, 16); assert.equal((await b.list()).length, 14);
		const carrier = createLanCarrier({ getSettings: () => ({ vaultId: "A", deviceName: "test" }), updateSettings: async () => undefined, filesFor: () => files, log: () => undefined, onProblem: () => undefined });
		const backendA = carrier.snapshotBackend("A", () => doc); const backendB = carrier.snapshotBackend("B", () => doc);
		assert.notEqual(backendA, backendB); assert.equal(carrier.snapshotBackend("A", () => doc), backendA);
		assert((await backendB.list()).every((index) => index.vaultId === "B"));
	} finally { doc.destroy(); }
});

s.test("R7: refresh failures after successful validation preserve hosted diagnostics through real vault APIs", async () => {
	for (const failure of ["network", "invalid_client", "429", "503", "invalid_grant"]) {
		let n = 0;
		const manager = new HostedTokenManager(async () => {
			if (++n === 1) return { status: 200, body: new TextEncoder().encode(JSON.stringify({ access_token: "once" })) };
			if (failure === "network") throw new Error("offline");
			return { status: /^\d/.test(failure) ? Number(failure) : 400, body: new TextEncoder().encode(JSON.stringify({ error: failure })) };
		}, "https://example.invalid", "test-token");
		await manager.provider();
		const api = new GoogleDriveRest(async () => ({ status: 401, body: new Uint8Array() }), manager.provider);
		await assert.rejects(() => api.findFolders("vault"), (err: unknown) => {
			assert(err instanceof HostedAuthError);
			const hint = failure === "network" ? "No connection" : failure === "invalid_client" ? "configuration problem" : failure === "429" ? "rate limiting" : failure === "503" ? "temporary problem" : "rejected the refresh token";
			assert(explainSetupError(err).includes(hint)); return true;
		});
		assert.equal(manager.revoked, failure === "invalid_grant");
	}
});

await s.done();
