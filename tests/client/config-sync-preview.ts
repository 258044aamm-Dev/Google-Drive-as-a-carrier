import assert from "node:assert/strict";
import * as Y from "yjs";
import { suite } from "../harness.ts";
import { ConfigSyncPreview, type ConfigPreviewCheckpoint, type ConfigPreviewHost } from "../../src/config-sync/preview";
import { CONFIG_NAMESPACE, ConfigRevisionStore, MAX_CONFIG_REVISIONS } from "../../src/config-sync/revisionStore";
import { configRoot, digest, projectConfig } from "../../src/config-sync/policy";
import { isExcluded } from "../../src/sync/exclude";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { DriveKeyring } from "../../src/drive-carrier/driveKeyring";
import { FakeDrive } from "../mocks/fakeDrive";
import { generateLanKey, makeNode, waitFor } from "../mocks/lanRig";

const s = suite("config-sync-preview");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const project = (value: boolean): string => JSON.stringify({ vimMode: value });
function rig(extra: Partial<ConfigPreviewHost> = {}) {
	const doc = extra.doc ?? new Y.Doc();
	const files = new Map<string, string>([[".obsidian/app.json", project(false)]]);
	let checkpoint: ConfigPreviewCheckpoint | null = null;
	let ready = true; let reads = 0;
	const host: ConfigPreviewHost = {
		doc, vault: "vault-test", root: ".obsidian", autoTimers: false, checkpoint: null,
		ready: () => ready,
		stat: async (path) => files.has(path) ? { type: "file", size: new TextEncoder().encode(files.get(path)!).length } : null,
		read: async (path) => { reads++; return files.get(path)!; },
		saveCheckpoint: async (next) => { checkpoint = next; }, ...extra,
	};
	const preview = new ConfigSyncPreview(host);
	return { doc, files, host, preview, ready: (v: boolean) => { ready = v; }, reads: () => reads, checkpoint: () => checkpoint,
		stop: () => { preview.destroy(); if (!extra.doc) doc.destroy(); } };
}

s.test("B06/B07: app projection excludes credentials, endpoints, unknown and prototype fields", () => {
	assert.equal(projectConfig("app.json", '{"vimMode":true,"token":"secret","host":"bad","__proto__":{"polluted":true},"pluginSettings":{"password":"secret"}}'), project(true));
	assert.throws(() => projectConfig("app.json", '{"vimMode":"secret"}'));
});
s.test("B05/H01: appearance projection admits bounded reviewed fields only", () => {
	assert.equal(projectConfig("appearance.json", '{"theme":"moonstone","accentColor":"#AAbbCC","cssTheme":"secret","baseFontSize":16}'), '{"accentColor":"#aabbcc","baseFontSize":16,"theme":"moonstone"}');
	for (const raw of ['{"baseFontSize":999}', '{"theme":"file:///secret"}', '{"accentColor":"password"}']) assert.throws(() => projectConfig("appearance.json", raw));
});
s.test("B04: hotkeys are structured and canonical, not opaque plugin settings", () => {
	assert.equal(projectConfig("hotkeys.json", '{"editor:save":[{"key":"S","modifiers":["Shift","Mod","Mod"]}]}'), '{"editor:save":[{"modifiers":["Mod","Shift"],"key":"S"}]}');
	for (const raw of ['{"token":"secret"}', '{"editor:save":[{"key":"S","modifiers":["unknown"]}]}', '{"editor:save":[{"key":"S","modifiers":[],"token":"secret"}]}', '{"__proto__":[]}']) assert.throws(() => projectConfig("hotkeys.json", raw));
});
s.test("C03/C14/J03: malformed, excessive, array and unsafe paths fail closed", () => {
	for (const raw of ['null', '[]', '{', ' '.repeat(33000)]) assert.throws(() => projectConfig("app.json", raw));
	for (const root of ['../outside', '/tmp', '.', '.obsidian/../x', 'C:\\temp', 'a//b', 'a\u0000b']) assert.throws(() => configRoot(root));
	assert.equal(configRoot("custom/config"), "custom/config");
});
s.test("B10/J07: original config-directory exclusion remains unchanged", () => {
	assert(isExcluded(".obsidian/app.json", [], ".obsidian"));
	assert(isExcluded("custom/config/plugins/yaos/data.json", [], "custom/config"));
	assert(!isExcluded("notes/test.md", [], ".obsidian"));
});
s.test("A02: empty device cannot seed or publish deletions", async () => {
	const r = rig(); r.files.clear();
	try { await r.preview.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 0); assert.match(r.preview.status, /populated baseline/); }
	finally { r.stop(); }
});
s.test("A06: no scanning or metadata writes before full readiness", async () => {
	const r = rig(); r.ready(false);
	try { await r.preview.tick(); assert.equal(r.reads(), 0); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 0); }
	finally { r.stop(); }
});
s.test("A01/B10: initial baseline contains only approved projections and no live-file writes", async () => {
	const r = rig(); r.files.set(".obsidian/app.json", '{"vimMode":true,"token":"never-upload"}');
	r.files.set(".obsidian/plugins/yaos/data.json", '{"token":"never-read"}');
	const original = [...r.files];
	try {
		await r.preview.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 1);
		assert(!JSON.stringify(r.doc.getMap(CONFIG_NAMESPACE).toJSON()).includes("never-"));
		assert.deepEqual([...r.files], original); assert.equal(r.reads(), 2);
		assert.match(r.preview.status, /safety-blocked/); assert(r.checkpoint());
	} finally { r.stop(); }
});
s.test("A03: joining populated device does not overwrite or republish its initial local files", async () => {
	const a = rig(); const b = rig();
	try {
		await a.preview.tick(); Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
		b.files.set(".obsidian/app.json", project(true)); await b.preview.tick();
		assert.equal(b.doc.getMap(CONFIG_NAMESPACE).size, 1); assert.equal(b.files.get(".obsidian/app.json"), project(true));
	} finally { a.stop(); b.stop(); }
});
s.test("D07/G07: unchanged local config does not echo a remotely staged winner", async () => {
	const a = rig(); const b = rig();
	try {
		await a.preview.tick(); Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc)); await b.preview.tick();
		a.files.set(".obsidian/app.json", project(true)); await a.preview.tick(); Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
		await b.preview.tick(); await b.preview.tick();
		assert.equal(b.doc.getMap(CONFIG_NAMESPACE).size, 2); assert.equal(b.files.get(".obsidian/app.json"), project(false));
	} finally { a.stop(); b.stop(); }
});
s.test("F09: persisted source checkpoint captures edits made while app was closed", async () => {
	const r = rig();
	try {
		await r.preview.tick(); const checkpoint = r.checkpoint(); r.preview.destroy();
		r.files.set(".obsidian/app.json", project(true));
		const restarted = new ConfigSyncPreview({ ...r.host, checkpoint });
		try { await restarted.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 2); }
		finally { restarted.destroy(); }
	} finally { r.stop(); }
});
s.test("A12: mismatched vault checkpoint is ignored rather than imported", async () => {
	const r = rig({ checkpoint: { version: 1, vault: "other", root: ".obsidian", hashes: { "app.json": "0".repeat(64) } } });
	try { await r.preview.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 1); }
	finally { r.stop(); }
});
s.test("C13: file changing between reads is not published", async () => {
	let n = 0; const r = rig({ read: async () => project(++n % 2 === 0) });
	try { await r.preview.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 0); assert.match(r.preview.status, /changing-rescan/); }
	finally { r.stop(); }
});
s.test("C06/C11: oversized or inaccurate stat data cannot bypass payload validation", async () => {
	for (const size of [Infinity, -1, 40000, 1]) {
		const r = rig({ stat: async () => ({ type: "file", size }), read: async () => ' '.repeat(40000) });
		try { await r.preview.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 0); }
		finally { r.stop(); }
	}
});
s.test("E01/F08: timeout releases queue and late read cannot publish", async () => {
	let release = (_text: string): void => undefined;
	const held = new Promise<string>((resolve) => { release = resolve; });
	const r = rig({ timeoutMs: 15, read: () => held });
	try {
		await r.preview.tick(); assert.match(r.preview.status, /timeout/);
		r.preview.destroy(); release(project(true)); await sleep(10);
		assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 0);
	} finally { release(project(false)); r.stop(); }
});
s.test("E15: storage failures are bounded, redacted, and do not alter source files", async () => {
	let attempts = 0;
	const r = rig({ read: async () => { attempts++; throw new Error("token=SECRET"); } });
	try {
		for (let i = 0; i < 5; i++) await r.preview.tick();
		assert.equal(attempts, 3); assert.match(r.preview.status, /Paused/); assert(!r.preview.status.includes("SECRET"));
		assert.equal(r.files.get(".obsidian/app.json"), project(false));
	} finally { r.stop(); }
});
s.test("F08: destroy during read prevents checkpoint and publication", async () => {
	let release = (_text: string): void => undefined; let entered = false; let saves = 0;
	const held = new Promise<string>((r) => { release = r; });
	const r = rig({ read: () => { entered = true; return held; }, saveCheckpoint: async () => { saves++; } });
	try {
		const tick = r.preview.tick(); assert(await waitFor(() => entered)); r.preview.destroy();
		await tick; release(project(true)); await sleep(10);
		assert.equal(saves, 0); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 0);
	} finally { release(project(false)); r.stop(); }
});
s.test("D03/C12: missing previously observed file never emits an implicit deletion", async () => {
	const r = rig();
	try { await r.preview.tick(); r.files.clear(); await r.preview.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 1); }
	finally { r.stop(); }
});
s.test("F01/F09: checkpoint write failure retains shared proposal without duplicate publication on retry", async () => {
	let fail = true; const r = rig({ saveCheckpoint: async () => { if (fail) throw new Error("quota"); } });
	try { await r.preview.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 1); fail = false; await r.preview.tick(); assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 1); }
	finally { r.stop(); }
});
s.test("D01/D02/D08: concurrent edits converge in either delivery order with losers retained", async () => {
	const a = new Y.Doc(); const b = new Y.Doc(); const ca = new ConfigRevisionStore(a, "v", "aaaaaaaa"); const cb = new ConfigRevisionStore(b, "v", "bbbbbbbb");
	try {
		await ca.seed({ "app.json": project(false) }); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		await ca.publish("app.json", project(true)); await cb.publish("app.json", '{"vimMode":false,"spellcheck":true}');
		await ca.publish("appearance.json", '{"theme":"system"}');
		const ua = Y.encodeStateAsUpdate(a); const ub = Y.encodeStateAsUpdate(b);
		Y.applyUpdate(a, ub); Y.applyUpdate(b, ua);
		const av = await ca.view(); const bv = await cb.view(); assert.deepEqual(av.values, bv.values);
		assert.equal(av.values["app.json"], '{"spellcheck":true,"vimMode":false}');
		assert.equal(av.values["appearance.json"], '{"theme":"system"}'); assert.equal(av.revisions, 4); assert(av.retainedAlternatives >= 1);
		await ca.publish("app.json", project(true)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); assert.equal((await cb.view()).values["app.json"], project(true));
	} finally { ca.destroy(); cb.destroy(); a.destroy(); b.destroy(); }
});
s.test("A04: simultaneous baselines elect one deterministically and retain both proposals", async () => {
	const a = new Y.Doc(); const b = new Y.Doc(); const ca = new ConfigRevisionStore(a, "v", "aaaaaaaa"); const cb = new ConfigRevisionStore(b, "v", "bbbbbbbb");
	try {
		await ca.seed({ "app.json": project(false) }); await cb.seed({ "app.json": project(true) });
		const ua = Y.encodeStateAsUpdate(a); const ub = Y.encodeStateAsUpdate(b); Y.applyUpdate(a, ub); Y.applyUpdate(b, ua);
		assert.deepEqual((await ca.view()).values, (await cb.view()).values); assert.equal((await ca.view()).revisions, 2);
	} finally { ca.destroy(); cb.destroy(); a.destroy(); b.destroy(); }
});
s.test("E05/E06: tampered bytes and wrong-vault metadata cannot become staged winners", async () => {
	const a = new Y.Doc(); const ca = new ConfigRevisionStore(a, "v", "aaaaaaaa");
	try {
		await ca.seed({ "app.json": project(false) });
		const wrong = new ConfigRevisionStore(a, "other", "bbbbbbbb");
		try { await assert.rejects(() => wrong.view()); } finally { wrong.destroy(); }
		const map = a.getMap<string>(CONFIG_NAMESPACE); const id = [...map.keys()][0]!; map.set(id, map.get(id)!.replace('false', 'true'));
		await assert.rejects(() => ca.view(), /hash/);
	} finally { ca.destroy(); a.destroy(); }
});
s.test("D10/I02: missing parents, forged rank and unknown versions block processing", async () => {
	for (const mutation of ["parent", "rank", "version"]) {
		const doc = new Y.Doc(); const store = new ConfigRevisionStore(doc, "v", "aaaaaaaa");
		try {
			await store.seed({ "app.json": project(false) }); await store.publish("app.json", project(true));
			const map = doc.getMap<string>(CONFIG_NAMESPACE);
			const [id, raw] = [...map.entries()].find(([, text]) => JSON.parse(text).kind === "put")!;
			const value = JSON.parse(raw) as Record<string, unknown>;
			if (mutation === "parent") value.parents = ["0".repeat(64)]; else if (mutation === "rank") value.rank = 90; else value.version = 2;
			const next = JSON.stringify(value); map.delete(id); map.set(await digest(next), next);
			await assert.rejects(() => store.view());
		} finally { store.destroy(); doc.destroy(); }
	}
});
s.test("F11/J03: history cap pauses rather than pruning recoverable alternatives", async () => {
	const doc = new Y.Doc(); const store = new ConfigRevisionStore(doc, "v", "aaaaaaaa");
	try {
		await store.seed({ "app.json": project(false) });
		const map = doc.getMap<string>(CONFIG_NAMESPACE); const original = [...map.entries()][0]!;
		for (let i = 0; i < MAX_CONFIG_REVISIONS; i++) map.set(String(i), "{}");
		await assert.rejects(() => store.view(), /history-limit/); assert.equal(map.get(original[0]), original[1]);
	} finally { store.destroy(); doc.destroy(); }
});
s.test("I04/J07: preview does not modify note maps or the ordinary configuration exclusion", async () => {
	const r = rig(); r.doc.getText("note").insert(0, "note content");
	try { await r.preview.tick(); assert.equal(r.doc.getText("note").toString(), "note content"); assert.equal(r.doc.getMap("pathToBlob").size, 0); assert.equal(r.doc.getMap("meta").size, 0); }
	finally { r.stop(); }
});
s.test("E08: real Drive transport carries staged projections with encryption and ordinary notes", async () => {
	const drive = new FakeDrive(); const a = new Y.Doc(); const b = new Y.Doc();
	const make = (doc: Y.Doc, id: string) => new DriveTransport(doc, drive.client(), { vaultId: "vault-test", deviceId: id, autoTimers: false, keyring: new DriveKeyring(drive.client(), { vaultId: "vault-test", passphrase: "test secret", kdfIterations: 1000 }) });
	const ta = make(a, "A"); const tb = make(b, "B"); const ra = rig({ doc: a }); const rb = rig({ doc: b });
	try {
		await ta.connect(); a.getText("note").insert(0, "ordinary note"); await ra.preview.tick(); await ta.syncNow(); await tb.connect(); await tb.syncNow(); await rb.preview.tick();
		assert.equal(b.getText("note").toString(), "ordinary note"); assert.equal(b.getMap(CONFIG_NAMESPACE).size, 1); assert.match(rb.preview.status, /staged/);
	} finally { ra.stop(); rb.stop(); ta.destroy(); tb.destroy(); a.destroy(); b.destroy(); }
});
s.test("E10: real loopback LAN transport carries staged projections without live config writes", async () => {
	const key = generateLanKey(); const a = makeNode("config-a", key); const b = makeNode("config-b", key);
	const ra = rig({ doc: a.doc }); const rb = rig({ doc: b.doc });
	try {
		await a.transport.connect(); await b.transport.connect(); a.linkTo(b);
		assert(await waitFor(() => a.transport.synced && b.transport.synced));
		a.doc.getText("note").insert(0, "LAN note"); await ra.preview.tick();
		assert(await waitFor(() => b.doc.getMap(CONFIG_NAMESPACE).size === 1)); await rb.preview.tick();
		assert.equal(b.doc.getText("note").toString(), "LAN note"); assert.equal(rb.files.get(".obsidian/app.json"), project(false));
	} finally { ra.stop(); rb.stop(); a.stop(); b.stop(); a.doc.destroy(); b.doc.destroy(); }
});

s.test("A12/E12: identity/readiness change during capture prevents publication", async () => {
	let release = (_text: string): void => undefined; let entered = false;
	const held = new Promise<string>((resolve) => { release = resolve; });
	const r = rig({ read: () => { entered = true; return held; } });
	try {
		const tick = r.preview.tick(); assert(await waitFor(() => entered));
		r.ready(false); release(project(true)); await tick;
		assert.equal(r.doc.getMap(CONFIG_NAMESPACE).size, 0); assert.equal(r.checkpoint(), null);
	} finally { release(project(false)); r.stop(); }
});
s.test("C01: a custom configuration directory is read without scanning unrelated paths", async () => {
	const paths: string[] = [];
	const r = rig({ root: "custom/config", stat: async (path) => { paths.push(path); return null; } });
	try { await r.preview.tick(); assert.deepEqual(paths, ["custom/config/app.json", "custom/config/appearance.json", "custom/config/hotkeys.json"]); }
	finally { r.stop(); }
});
s.test("D01/D07: three concurrent writers converge under all six arrival permutations", async () => {
	const root = new Y.Doc(); const base = new ConfigRevisionStore(root, "v", "baseline");
	const docs: Y.Doc[] = [root]; const stores: ConfigRevisionStore[] = [base];
	try {
		await base.seed({ "app.json": project(false) });
		const updates: Uint8Array[] = [];
		for (const [author, text] of [["aaaaaaaa", project(true)], ["bbbbbbbb", '{"spellcheck":true}'], ["cccccccc", '{"showLineNumber":true}']]) {
			const doc = new Y.Doc(); docs.push(doc); Y.applyUpdate(doc, Y.encodeStateAsUpdate(root));
			const store = new ConfigRevisionStore(doc, "v", author!); stores.push(store);
			await store.publish("app.json", text!); updates.push(Y.encodeStateAsUpdate(doc));
		}
		for (const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) {
			const doc = new Y.Doc(); docs.push(doc); const store = new ConfigRevisionStore(doc, "v", "receiver"); stores.push(store);
			for (const i of [...order, ...order]) Y.applyUpdate(doc, updates[i]!);
			const view = await store.view(); assert.equal(view.values["app.json"], '{"showLineNumber":true}'); assert.equal(view.revisions, 4);
		}
	} finally { stores.forEach((store) => store.destroy()); docs.forEach((doc) => doc.destroy()); }
});
s.test("I01/I04: an opaque older replica and whole-document snapshot preserve the namespace", async () => {
	const a = rig(); const older = new Y.Doc(); const restored = new Y.Doc();
	try {
		await a.preview.tick(); Y.applyUpdate(older, Y.encodeStateAsUpdate(a.doc));
		older.getText("note").insert(0, "old client edit");
		Y.applyUpdate(restored, Y.encodeStateAsUpdate(older));
		const reader = new ConfigRevisionStore(restored, "vault-test", "new-reader");
		try { assert.equal((await reader.view()).values["app.json"], project(false)); assert.equal(restored.getText("note").toString(), "old client edit"); }
		finally { reader.destroy(); }
	} finally { a.stop(); older.destroy(); restored.destroy(); }
});

await s.done();
