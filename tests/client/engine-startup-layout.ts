/**
 * Upstream issue #77: the first reconcile after startup saw a note that was open
 * in the last session as "closed" (its tab was still a placeholder), and kept the
 * typed disk text as a "- disk" conflict copy. The fix waits for the workspace
 * layout before that first reconcile.
 *
 * Part 1: the wait helper. Part 2: the reconcile itself, to show WHY the wait is
 * needed (open note: untouched; closed note: copy) and that nothing else changed.
 * Part 3: the wait sits before the startup reconcile in `initSync`.
 */
import { MarkdownView, TFile, type App } from "obsidian";
import { readFileSync } from "node:fs";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { RuntimeConfig } from "../../src/runtime/runtimeConfig";
import { waitForLayoutReady, LAYOUT_READY_TIMEOUT_MS } from "../../src/runtime/waitForLayoutReady";
import type { DiskIndex } from "../../src/sync/diskIndex";
import type { DiskMirror } from "../../src/sync/diskMirror";
import { VaultSync } from "../../src/sync/vaultSync";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { fixtureOf, partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

process.on("unhandledRejection", (reason) => {
	if (reason instanceof ReferenceError && /indexedDB/.test(reason.message)) return;
	throw reason instanceof Error ? reason : new Error(String(reason));
});
const s = suite("engine-startup-layout");

// ── 1: the wait helper ──
s.section("1: waitForLayoutReady");
{
	const ready = await waitForLayoutReady({ layoutReady: true, onLayoutReady: () => { throw new Error("must not register"); } });
	s.check(ready === "already-ready", "a ready layout returns at once");

	let fire: () => void = () => undefined;
	const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
	const opts = {
		setTimer: (cb: () => void, ms: number) => { const t = { cb, ms, cleared: false }; timers.push(t); return t; },
		clearTimer: (h: unknown) => { (h as { cleared: boolean }).cleared = true; },
	};
	const pending = waitForLayoutReady({ layoutReady: false, onLayoutReady: (cb) => { fire = cb; } }, opts);
	let settled = false;
	void pending.then(() => { settled = true; });
	await Promise.resolve();
	s.check(!settled, "a layout that is not ready keeps it waiting");
	s.check(timers[0]?.ms === LAYOUT_READY_TIMEOUT_MS, "the safety timeout is the default");
	fire();
	s.check(await pending === "ready" && timers[0]?.cleared === true, "the layout callback resolves it and clears the timer");

	const late = waitForLayoutReady({ layoutReady: false, onLayoutReady: () => undefined }, { ...opts, timeoutMs: 5 });
	timers[1]?.cb();
	s.check(await late === "timeout", "a layout that never comes does not block sync for good");
}

// ── 2: the reconcile ──
s.section("2: an open note is left alone, a note that looks closed gets a copy");
async function startup(openNote: boolean): Promise<{ created: string[]; text: string; flushed: string[] }> {
	const drive = new FakeDrive();
	const vs = new VaultSync({ ...DEFAULT_SETTINGS, vaultId: "l77", deviceName: "dev" }, {
		transportFactory: (ctx) => new DriveTransport(ctx.doc, drive.client(), { vaultId: "l77", deviceId: "dev", autoTimers: false, ignoreOrigin: ctx.isLocalStoreOrigin }),
	});
	// The note was typed in after the last save: the CRDT is behind the disk, and no baseline hash exists.
	vs.ensureFile("Fresh.md", "hello", "dev");
	const created: string[] = [];
	const flushed: string[] = [];
	const files = new Set<string>(["Fresh.md"]);
	const file = fixtureOf<TFile>(TFile, { path: "Fresh.md" });
	const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, { file });
	let index: DiskIndex = {};
	const app = partialOf<App>({
		vault: {
			getMarkdownFiles: () => [file],
			read: async () => "hello world",
			getAbstractFileByPath: (p: string) => (files.has(p) ? file : null),
			create: async (p: string) => { created.push(p); files.add(p); return file; },
			adapter: { stat: async () => ({ type: "file", ctime: 1, mtime: 1, size: 11 }) },
		},
		workspace: { iterateAllLeaves: (cb: (leaf: never) => void) => { if (openNote) cb({ view } as never); } },
	});
	const controller = new ReconciliationController({
		app,
		getSettings: () => partialOf<VaultSyncSettings>({ deviceName: "dev" }),
		getRuntimeConfig: () => partialOf<RuntimeConfig>({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [] }),
		getVaultSync: () => vs,
		getDiskMirror: () => partialOf<DiskMirror>({ flushWrite: async (p: string) => { flushed.push(p); } }),
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => index,
		setDiskIndex: (next: DiskIndex) => { index = next; },
		isMarkdownPathSyncable: () => true,
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
	await controller.runReconciliation("authoritative");
	const text = vs.getTextForPath("Fresh.md")?.toString() ?? "";
	await vs.destroy().catch(() => undefined);
	return { created, text, flushed };
}
{
	const open = await startup(true);
	s.check(open.created.length === 0, `layout ready, note open: no conflict copy (got ${open.created.join(",") || "none"})`);
	const closed = await startup(false);
	s.check(closed.created.length === 1 && /disk/.test(closed.created[0] ?? ""), `note not yet seen as open: the "- disk" copy appears (got ${closed.created.join(",") || "none"})`);
}

// ── 3: wiring ──
s.section("3: initSync waits for the layout before the first reconcile");
{
	const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
	const wait = main.indexOf("await waitForLayoutReady(");
	const startupReconcile = main.indexOf("this.log(`Reconciliation mode: ${mode}`)");
	s.check(wait > 0 && startupReconcile > wait, "the wait comes before the startup reconcile");
	s.check(main.split("waitForLayoutReady(").length === 2, "it is called once, so reconnect reconciles are not gated");
}
await s.done();
