/**
 * A deleted "(YAOS conflict ...)" note came back after reopening, on both
 * devices. The delete event ignored it (not a syncable path), and a full reconcile
 * wrote any active shared entry for it back. Real VaultSync and
 * ReconciliationController, fake app.
 */
import { TFile, type App } from "obsidian";
import * as Y from "yjs";
import { readFileSync } from "node:fs";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { RuntimeConfig } from "../../src/runtime/runtimeConfig";
import { shouldRecordMarkdownDelete, withoutConflictNotes } from "../../src/runtime/reconcile/conflictNotePolicy";
import { isMarkdownSyncable } from "../../src/types";
import type { DiskIndex } from "../../src/sync/diskIndex";
import type { DiskMirror } from "../../src/sync/diskMirror";
import { VaultSync, type ReconcileMode } from "../../src/sync/vaultSync";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { fixtureOf, partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

process.on("unhandledRejection", (reason) => {
	if (reason instanceof ReferenceError && /indexedDB/.test(reason.message)) return;
	throw reason instanceof Error ? reason : new Error(String(reason));
});
const s = suite("engine-conflict-note-delete");

const CONFLICT = "Notes/Idea (YAOS conflict - disk from dev 2026-10-02T18-30-05Z).md";
const CONFLICT_2 = "Notes/Idea (YAOS conflict - crdt from dev 2026-10-02T18-31-00Z) 2.md";

// ── policy ──
s.section("policy");
s.check(shouldRecordMarkdownDelete({ path: "Notes/Idea.md", syncable: true, activeInSharedDoc: false }), "an ordinary note: recorded (as before)");
s.check(shouldRecordMarkdownDelete({ path: CONFLICT, syncable: false, activeInSharedDoc: true }), "a conflict note that is an active shared entry: recorded");
s.check(!shouldRecordMarkdownDelete({ path: CONFLICT, syncable: false, activeInSharedDoc: false }), "a conflict note that is not shared: still ignored");
s.check(!shouldRecordMarkdownDelete({ path: "Notes/Ignored.md", syncable: false, activeInSharedDoc: true }), "an ignored ordinary note: still ignored");
s.check(withoutConflictNotes(["a.md", CONFLICT, CONFLICT_2, "b (conflict).md"]).join("|") === "a.md|b (conflict).md", "only real conflict-note names are dropped");

// ── harness ──
interface Rig {
	vs: VaultSync;
	run: (mode?: ReconcileMode) => Promise<void>;
	flushed: string[];
	onDisk: Set<string>;
	index: DiskIndex;
}
function makeRig(): Rig {
	const drive = new FakeDrive();
	const vs = new VaultSync({ ...DEFAULT_SETTINGS, vaultId: "cn", deviceName: "dev" }, {
		transportFactory: (ctx) => new DriveTransport(ctx.doc, drive.client(), { vaultId: "cn", deviceId: "dev", autoTimers: false, ignoreOrigin: ctx.isLocalStoreOrigin }),
	});
	const flushed: string[] = [];
	const onDisk = new Set<string>();
	const rig: Rig = { vs, flushed, onDisk, index: {}, run: async () => undefined };
	const app = partialOf<App>({
		vault: {
			getMarkdownFiles: () => [...onDisk].map((path) => fixtureOf<TFile>(TFile, { path })),
			read: async (file: TFile) => `disk ${file.path}`,
			getAbstractFileByPath: () => null,
			adapter: { stat: async (path: string) => (onDisk.has(path) ? { type: "file", ctime: 1, mtime: 1, size: 1 } : null) },
		},
		workspace: { iterateAllLeaves: () => undefined },
	});
	const controller = new ReconciliationController({
		app,
		getSettings: () => partialOf<VaultSyncSettings>({ deviceName: "dev" }),
		getRuntimeConfig: () => partialOf<RuntimeConfig>({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [] }),
		getVaultSync: () => vs,
		getDiskMirror: () => partialOf<DiskMirror>({ flushWrite: async (path: string) => { flushed.push(path); } }),
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => rig.index,
		setDiskIndex: (next: DiskIndex) => { rig.index = next; },
		isMarkdownPathSyncable: (path: string) => isMarkdownSyncable(path, [], ".obsidian"),
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => undefined,
		validateOpenEditorBindings: () => undefined,
		onReconciled: () => undefined,
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => undefined,
		saveDiskIndex: async () => undefined,
		refreshStatusBar: () => undefined,
		trace: () => undefined,
		scheduleTraceStateSnapshot: () => undefined,
		log: () => undefined,
	});
	rig.run = async (mode = "authoritative") => { await controller.runReconciliation(mode); };
	return rig;
}
const active = (vs: VaultSync, path: string) => vs.getActiveMarkdownPaths().includes(path);
const quiet = async (r: Rig) => { await r.vs.destroy().catch(() => undefined); };

s.section("1: a conflict note held as an active shared entry is not written back at startup");
{
	const r = makeRig();
	r.vs.ensureFile(CONFLICT, "kept text", "dev"); // the old entry (it synced in 2.1.0)
	r.vs.ensureFile("Real.md", "real note", "dev"); // an ordinary note missing on disk
	await r.run();
	s.check(!r.flushed.includes(CONFLICT), `the conflict note is not written to disk (flushed: ${r.flushed.join(", ")})`);
	s.check(r.flushed.includes("Real.md"), "control: an ordinary shared note missing on disk is still written");
	await quiet(r);
}

s.section("2: the conflict note exists on disk: the reconcile does not touch it either");
{
	const r = makeRig();
	r.vs.ensureFile(CONFLICT, "kept text", "dev");
	r.onDisk.add(CONFLICT);
	await r.run();
	s.check(!r.flushed.includes(CONFLICT), "no write is attempted for a conflict note that is present");
	await quiet(r);
}

s.section("3: delete of an active conflict note is recorded and reaches the other device");
{
	const r = makeRig();
	r.vs.ensureFile(CONFLICT, "kept text", "dev");
	const other = new Y.Doc();
	Y.applyUpdate(other, Y.encodeStateAsUpdate(r.vs.ydoc));
	const activeOn = (doc: Y.Doc): number => {
		let n = 0;
		doc.getMap("meta").forEach((entry) => {
			const j: unknown = entry instanceof Y.Map ? entry.toJSON() : entry;
			if (typeof j === "object" && j !== null && Reflect.get(j, "path") === CONFLICT && Reflect.get(j, "deletedAt") === undefined && Reflect.get(j, "deleted") !== true) n++;
		});
		return n;
	};
	s.check(activeOn(other) === 1, "setup: the other device holds the entry");
	// what the delete handler now does for this path
	const record = shouldRecordMarkdownDelete({ path: CONFLICT, syncable: isMarkdownSyncable(CONFLICT, [], ".obsidian"), activeInSharedDoc: r.vs.getFileId(CONFLICT) !== undefined });
	s.check(record, "the delete handler decides to record it");
	if (record) r.vs.handleDelete(CONFLICT, "dev");
	s.check(!active(r.vs, CONFLICT), "it is no longer active here");
	Y.applyUpdate(other, Y.encodeStateAsUpdate(r.vs.ydoc));
	s.check(activeOn(other) === 0, "and not active on the other device");
	await r.run();
	s.check(!r.flushed.includes(CONFLICT) && !active(r.vs, CONFLICT), "a reopen (reconcile) does not bring it back");
	await quiet(r);
}

s.section("4: the delete handler in main.ts uses the policy");
{
	const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
	const i = main.indexOf('this.app.vault.on("delete"');
	const block = main.slice(i, i + 1200);
	s.check(i > 0 && block.includes("shouldRecordMarkdownDelete("), "the delete event asks shouldRecordMarkdownDelete");
	s.check(!block.includes("if (this.isMarkdownPathSyncable(file.path)) {"), "and no longer tests only the plain syncable rule");
}
await s.done();
