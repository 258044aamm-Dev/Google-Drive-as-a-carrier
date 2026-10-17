/**
 * Cloudflare: optional "send my edits in groups" (Sync speed).
 *
 * The default must be exactly today's behaviour: every edit goes out at once
 * through the provider's own forwarder, which this feature does not even touch.
 */

import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import YSyncProvider from "y-partyserver/provider";
import { OutgoingUpdateBatcher, type BatcherTimers, type UpdateForwarder } from "../../src/sync/outgoingBatcher";
import { VaultSync } from "../../src/sync/vaultSync";
import { DEFAULT_SETTINGS } from "../../src/settings/settingsStore";
import { resolveCloudflareBatchMs } from "../../src/settings/syncPace";
import { suite } from "../harness.ts";

const s = suite("cloudflare-edit-batching");

process.on("unhandledRejection", (reason) => {
	if (reason instanceof ReferenceError && /indexedDB/.test(reason.message)) return;
	throw reason instanceof Error ? reason : new Error(String(reason));
});

class FakeTimers implements BatcherTimers {
	next = 1;
	tasks = new Map<number, () => void>();
	set(fn: () => void): unknown { const id = this.next++; this.tasks.set(id, fn); return id; }
	clear(handle: unknown): void { this.tasks.delete(handle as number); }
	fireAll(): void { const all = [...this.tasks.values()]; this.tasks.clear(); for (const fn of all) fn(); }
}

/** A stand-in for the provider: it records what it would put on the wire, and ignores updates it applied itself. */
function makeProvider(doc: Y.Doc) {
	const sent: Uint8Array[] = [];
	const provider: UpdateForwarder = {
		_updateHandler: (update, origin) => { if (origin !== provider) sent.push(update); },
	};
	doc.on("update", provider._updateHandler);
	return { provider, sent };
}

function applyAll(updates: Uint8Array[]): Y.Doc {
	const d = new Y.Doc();
	for (const u of updates) Y.applyUpdate(d, u);
	return d;
}

s.section("Test 1: off (the default) changes nothing");
{
	const doc = new Y.Doc();
	const { provider, sent } = makeProvider(doc);
	const before = provider._updateHandler;
	const batcher = new OutgoingUpdateBatcher(doc, provider, new FakeTimers());
	batcher.setDelayMs(0);
	s.check(!batcher.active && provider._updateHandler === before, "with 0 the provider's own forwarder stays in place");
	doc.getText("t").insert(0, "a");
	doc.getText("t").insert(1, "b");
	s.check(sent.length === 2, "every edit is sent at once, one message each");
	s.check(applyAll(sent).getText("t").toString() === "ab", "and they rebuild the text");
	for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY * 0]) { batcher.setDelayMs(bad); }
	s.check(!batcher.active, "a nonsense delay leaves it off");
	batcher.dispose();
	doc.getText("t").insert(2, "c");
	s.check(sent.length === 3, "dispose while off is harmless");
}

s.section("Test 2: gathering edits");
{
	const doc = new Y.Doc();
	const { provider, sent } = makeProvider(doc);
	const timers = new FakeTimers();
	const batcher = new OutgoingUpdateBatcher(doc, provider, timers);
	batcher.setDelayMs(2000);
	s.check(batcher.active, "turned on");
	for (let i = 0; i < 50; i++) doc.getText("t").insert(i, "x");
	doc.getMap("m").set("k", 1);
	s.check(sent.length === 0, "nothing is sent while gathering");
	s.check(timers.tasks.size === 1, "one timer for the whole group");
	timers.fireAll();
	s.check(sent.length === 1, "one merged message goes out when the timer fires");
	const rebuilt = applyAll(sent);
	s.check(rebuilt.getText("t").toString() === "x".repeat(50) && rebuilt.getMap("m").get("k") === 1, "the merged message holds every edit");
	s.check(Y.equalSnapshots(Y.snapshot(rebuilt), Y.snapshot(doc)), "the receiving document equals the sender");
	doc.getText("t").insert(0, "y");
	s.check(timers.tasks.size === 1 && sent.length === 1, "the next edit starts a new group");
	timers.fireAll();
	s.check(sent.length === 2 && applyAll(sent).getText("t").toString().startsWith("y"), "and is sent in its turn");
	timers.fireAll();
	s.check(sent.length === 2, "an empty timer sends nothing");
}

s.section("Test 3: nothing is lost or reordered");
{
	const doc = new Y.Doc();
	const { provider, sent } = makeProvider(doc);
	const timers = new FakeTimers();
	const batcher = new OutgoingUpdateBatcher(doc, provider, timers);
	batcher.setDelayMs(5000);
	// A remote edit applied by the provider itself is not sent back.
	const remote = new Y.Doc();
	remote.getText("t").insert(0, "remote");
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), provider);
	doc.getText("t").insert(6, "+local");
	timers.fireAll();
	s.check(sent.length === 1, "only the local edit is sent");
	const check = new Y.Doc();
	Y.applyUpdate(check, Y.encodeStateAsUpdate(remote));
	for (const u of sent) Y.applyUpdate(check, u);
	s.check(check.getText("t").toString() === "remote+local", "applied on top of the remote state it gives the right text");
	// Concurrent edit on another device merges the same with or without batching.
	const other = new Y.Doc();
	Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
	other.getText("t").insert(0, "O:");
	doc.getText("t").insert(0, "L:");
	timers.fireAll();
	Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
	s.check(doc.getText("t").toString() === other.getText("t").toString(), "two devices still converge");
}

s.section("Test 4: turning it off, and shutting down, send what is waiting");
{
	const doc = new Y.Doc();
	const { provider, sent } = makeProvider(doc);
	const original = provider._updateHandler;
	const timers = new FakeTimers();
	const batcher = new OutgoingUpdateBatcher(doc, provider, timers);
	batcher.setDelayMs(2000);
	doc.getText("t").insert(0, "a");
	doc.getText("t").insert(1, "b");
	batcher.setDelayMs(0);
	s.check(sent.length === 1 && !batcher.active && timers.tasks.size === 0, "switching to Normal flushes the waiting edits at once");
	doc.getText("t").insert(2, "c");
	s.check(sent.length === 2, "and edits go out one by one again");
	batcher.setDelayMs(1000);
	doc.getText("t").insert(3, "d");
	batcher.dispose();
	s.check(sent.length === 3 && provider._updateHandler === original, "dispose sends what is waiting and hands the forwarder back");
	doc.off("update", provider._updateHandler);
	doc.getText("t").insert(4, "e");
	s.check(sent.length === 3, "after the provider removes its own handler nothing is left behind (no listener leak)");
	batcher.dispose();
	s.check(applyAll(sent).getText("t").toString() === "abcd", "all edits arrived");
}

s.section("Test 5: hiding the window sends at once");
{
	const doc = new Y.Doc();
	const { provider, sent } = makeProvider(doc);
	const listeners = new Map<string, () => void>();
	const fakeDocument = {
		visibilityState: "visible",
		addEventListener: (n: string, fn: () => void) => { listeners.set(n, fn); },
		removeEventListener: (n: string) => { listeners.delete(n); },
	};
	Object.assign(globalThis, { document: fakeDocument });
	try {
		const batcher = new OutgoingUpdateBatcher(doc, provider, new FakeTimers());
		batcher.setDelayMs(9000);
		doc.getText("t").insert(0, "z");
		listeners.get("visibilitychange")?.();
		s.check(sent.length === 0, "still visible: keeps gathering");
		fakeDocument.visibilityState = "hidden";
		listeners.get("visibilitychange")?.();
		s.check(sent.length === 1, "hidden: sent now");
		batcher.dispose();
		s.check(!listeners.has("visibilitychange"), "the listener is removed on dispose");
	} finally {
		Reflect.deleteProperty(globalThis, "document");
	}
}

s.section("Test 6: the setting maps to a delay");
{
	s.check(resolveCloudflareBatchMs({}) === 0 && resolveCloudflareBatchMs({ syncPace: "normal" }) === 0, "default = off");
	s.check(resolveCloudflareBatchMs({ syncPace: "gentle" }) === 2000 && resolveCloudflareBatchMs({ syncPace: "minimal" }) === 5000, "gentle 2 s, minimal 5 s");
	const custom = (v: number | undefined) => resolveCloudflareBatchMs({ syncPace: "custom", syncPaceCustom: { cloudflareBatchSec: v } });
	s.check(custom(undefined) === 0 && custom(0) === 0 && custom(-3) === 0 && custom(Number.NaN) === 0, "custom: nothing, 0, negative, NaN = off");
	s.check(custom(7) === 7000 && custom(0.4) === 1000 && custom(500) === 30_000, "custom: used, raised to 1 s, capped at 30 s");
}

s.section("Test 7: through the real VaultSync on the Cloudflare path");
{
	// The provider registers browser window listeners; Node has none, so give it inert ones for this test.
	const hadAdd = "addEventListener" in globalThis;
	if (!hadAdd) Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined });
	let batchMs = 0;
	const vs = new VaultSync(
		{ ...DEFAULT_SETTINGS, host: "https://sync.invalid", token: "tok", vaultId: "v-batch" },
		{ getOutgoingBatchMs: () => batchMs },
	);
	const provider = vs.provider;
	if (!(provider instanceof YSyncProvider)) throw new Error("expected the Cloudflare provider");
	const wire: Uint8Array[] = [];
	const fakeWs = { readyState: 1, OPEN: 1, close: () => undefined, send: (b: Uint8Array) => { wire.push(b); } };
	Object.assign(provider, { ws: fakeWs });
	provider.wsconnected = true;
	const text = vs.ydoc.getText("t");
	text.insert(0, "a");
	text.insert(1, "b");
	s.check(wire.length === 2, "default: each edit is one message on the wire");
	batchMs = 60;
	vs.applyOutgoingBatchPace();
	text.insert(2, "c");
	text.insert(3, "d");
	text.insert(4, "e");
	s.check(wire.length === 2, "after choosing Gentle the edits are held");
	await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
	s.check(wire.length === 3, "and leave as one message");
	batchMs = 0;
	vs.applyOutgoingBatchPace();
	text.insert(5, "f");
	s.check(wire.length === 4, "back to Normal: immediate again");
	batchMs = 60_000;
	vs.applyOutgoingBatchPace();
	text.insert(6, "g");
	await vs.destroy().catch(() => undefined);
	// Replay everything that went out: the last edit must be in it (closing also sends awareness messages).
	const replay = new Y.Doc();
	for (const message of wire) {
		const decoder = decoding.createDecoder(message);
		if (decoding.readVarUint(decoder) !== 0) continue;
		syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), replay, null);
	}
	s.check(replay.getText("t").toString() === "abcdefg", "closing the vault sends what was waiting; replaying the wire gives every edit");
	// Without the option (every other caller) there is no batching code at all.
	const plain = new VaultSync({ ...DEFAULT_SETTINGS, host: "https://sync.invalid", token: "tok", vaultId: "v-plain" });
	const pp = plain.provider;
	if (!(pp instanceof YSyncProvider)) throw new Error("expected the Cloudflare provider");
	const wire2: Uint8Array[] = [];
	Object.assign(pp, { ws: { readyState: 1, OPEN: 1, close: () => undefined, send: (b: Uint8Array) => { wire2.push(b); } } });
	pp.wsconnected = true;
	plain.applyOutgoingBatchPace();
	plain.ydoc.getText("t").insert(0, "x");
	s.check(wire2.length === 1, "without the option nothing changes");
	await plain.destroy().catch(() => undefined);
	if (!hadAdd) {
		Reflect.deleteProperty(globalThis, "addEventListener");
		Reflect.deleteProperty(globalThis, "removeEventListener");
	}
}

await s.done();
