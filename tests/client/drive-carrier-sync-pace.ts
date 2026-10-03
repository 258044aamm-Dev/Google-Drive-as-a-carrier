/**
 * Sync speed (Google Drive): the default is today's behaviour exactly, the
 * other speeds only slow things down, and changing the setting reaches the
 * running transport without a restart.
 */

import { App, Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import * as Y from "yjs";
import { createDriveCarrier } from "../../src/drive-carrier/driveCarrierRuntime";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import type { ActivityEvent, ActivitySource } from "../../src/drive-carrier/activity";
import {
	CUSTOM_LIMITS,
	NORMAL_DRIVE_PACE,
	currentSyncPace,
	resolveDrivePace,
	type SyncPaceSettings,
} from "../../src/settings/syncPace";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { VaultSyncSettingTab, type VaultSyncSettingsHost } from "../../src/settings/settingsTab";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-sync-pace");
const SEC = 1000;

class FakeActivity implements ActivitySource {
	visible = true;
	listeners = new Set<(e: ActivityEvent) => void>();
	isVisible(): boolean { return this.visible; }
	subscribe(l: (e: ActivityEvent) => void): () => void {
		this.listeners.add(l);
		return () => { this.listeners.delete(l); };
	}
	fire(e: ActivityEvent): void {
		if (e === "hidden") this.visible = false;
		if (e === "visible") this.visible = true;
		for (const l of this.listeners) l(e);
	}
}

s.section("Test 1: the default is exactly today's behaviour");
{
	const want = (bg: number) => ({
		pollIntervalMs: 3000, idleAfterMs: 60_000, idlePollIntervalMs: 30_000,
		backgroundPollIntervalMs: bg, batchMs: 2000, reconcileIntervalMs: 300_000,
	});
	s.check(JSON.stringify(resolveDrivePace({}, false)) === JSON.stringify(want(120_000)), "nothing set, desktop = 3 s / 60 s / 30 s / 120 s hidden / 2 s batch / 5 min");
	s.check(JSON.stringify(resolveDrivePace({}, true)) === JSON.stringify(want(0)), "nothing set, phone = same, paused while hidden");
	s.check(JSON.stringify(resolveDrivePace({ syncPace: "normal" }, false)) === JSON.stringify(want(120_000)), "'normal' = nothing set");
	s.check(currentSyncPace({}) === "normal", "absent profile reads as normal");
	// Hand-edited or future data must not break syncing.
	// @ts-expect-error invalid on purpose: hand-edited data with a profile that does not exist
	const odd: SyncPaceSettings = { syncPace: "turbo" };
	s.check(currentSyncPace(odd) === "normal" && resolveDrivePace(odd, false).pollIntervalMs === 3000, "an unknown profile falls back to normal");
	s.check(!("syncPace" in DEFAULT_SETTINGS) && !("syncPaceCustom" in DEFAULT_SETTINGS), "the defaults store nothing for it");
	s.check(NORMAL_DRIVE_PACE.pollIntervalMs === 3000 && NORMAL_DRIVE_PACE.batchMs === 2000, "the documented constants");
}

s.section("Test 2: gentle and minimal");
{
	const g = resolveDrivePace({ syncPace: "gentle" }, false);
	s.check(g.pollIntervalMs === 10_000 && g.idlePollIntervalMs === 60_000 && g.backgroundPollIntervalMs === 300_000 && g.batchMs === 5000 && g.reconcileIntervalMs === 600_000, "gentle: 10 s / 60 s / 300 s / 5 s / 10 min");
	const m = resolveDrivePace({ syncPace: "minimal" }, false);
	s.check(m.pollIntervalMs === 30_000 && m.idlePollIntervalMs === 120_000 && m.backgroundPollIntervalMs === 900_000 && m.batchMs === 10_000 && m.reconcileIntervalMs === 1_800_000, "minimal: 30 s / 120 s / 900 s / 10 s / 30 min");
	s.check(resolveDrivePace({ syncPace: "gentle" }, true).backgroundPollIntervalMs === 0, "phones still pause while hidden");
}

s.section("Test 3: custom values can only slow things down");
{
	const base = NORMAL_DRIVE_PACE;
	const slow = resolveDrivePace({ syncPace: "custom", syncPaceCustom: { driveActiveSec: 20, driveIdleSec: 90, driveHiddenSec: 600, driveBatchSec: 8, driveFullCheckMin: 15 } }, false);
	s.check(slow.pollIntervalMs === 20_000 && slow.idlePollIntervalMs === 90_000 && slow.backgroundPollIntervalMs === 600_000 && slow.batchMs === 8000 && slow.reconcileIntervalMs === 900_000, "values inside the range are used");
	const fast = resolveDrivePace({ syncPace: "custom", syncPaceCustom: { driveActiveSec: 1, driveIdleSec: 1, driveHiddenSec: 1, driveBatchSec: 0, driveFullCheckMin: 0 } }, false);
	s.check(fast.pollIntervalMs === base.pollIntervalMs, "too fast: active is held at today's 3 s");
	s.check(fast.idlePollIntervalMs === CUSTOM_LIMITS.driveIdleSec.min * SEC, "too fast: idle is held at 30 s");
	s.check(fast.backgroundPollIntervalMs === 120_000, "too fast: hidden is held at 120 s");
	s.check(fast.batchMs === base.batchMs, "too fast: batch is held at 2 s");
	s.check(fast.reconcileIntervalMs === base.reconcileIntervalMs, "too fast: full check is held at 5 min");
	const huge = resolveDrivePace({ syncPace: "custom", syncPaceCustom: { driveActiveSec: 1e9, driveIdleSec: 1e9, driveHiddenSec: 1e9, driveBatchSec: 1e9, driveFullCheckMin: 1e9 } }, false);
	s.check(huge.pollIntervalMs === 600_000 && huge.batchMs === 60_000 && huge.reconcileIntervalMs === 120 * 60_000, "absurdly slow values are capped");
	const nan = resolveDrivePace({ syncPace: "custom", syncPaceCustom: { driveActiveSec: Number.NaN, driveBatchSec: Number.POSITIVE_INFINITY } }, false);
	s.check(nan.pollIntervalMs === 3000 && nan.batchMs === 2000, "NaN and Infinity fall back to today's value");
	s.check(resolveDrivePace({ syncPace: "custom", syncPaceCustom: { driveHiddenSec: 0 } }, false).backgroundPollIntervalMs === 0, "0 pauses while hidden");
	s.check(resolveDrivePace({ syncPace: "custom" }, false).backgroundPollIntervalMs === 120_000, "custom with nothing entered = today's numbers");
	s.check(resolveDrivePace({ syncPace: "custom" }, true).backgroundPollIntervalMs === 0, "custom on a phone with nothing entered = paused");

	// Property: no profile or custom value is ever faster than normal.
	let slower = true;
	const seeds = [-5, 0, 0.5, 1, 2, 3, 4, 10, 29, 31, 119, 121, 1000, 99999];
	for (const a of seeds) for (const b of seeds) {
		const p = resolveDrivePace({ syncPace: "custom", syncPaceCustom: { driveActiveSec: a, driveIdleSec: b, driveHiddenSec: a, driveBatchSec: b, driveFullCheckMin: a } }, false);
		if (p.pollIntervalMs < base.pollIntervalMs || p.idlePollIntervalMs < base.idlePollIntervalMs
			|| (p.backgroundPollIntervalMs !== 0 && p.backgroundPollIntervalMs < 120_000)
			|| p.batchMs < base.batchMs || p.reconcileIntervalMs < base.reconcileIntervalMs) slower = false;
	}
	s.check(slower, "property: over 196 combinations nothing is faster than the default");
}

s.section("Test 4: the carrier uses it, and live changes reach the running transport");
{
	const act = new FakeActivity();
	let settings: VaultSyncSettings & { syncPace?: SyncPaceSettings["syncPace"] } = { ...DEFAULT_SETTINGS, carrier: "drive", driveClientId: "i", driveClientSecret: "x", driveRefreshToken: "r", driveDeviceId: "d" };
	const carrier = createDriveCarrier({
		getSettings: () => settings,
		http: (async () => { throw new Error("no network in this test"); }) as never,
		log: () => {},
		onSignInLost: () => {},
		isMobile: () => false,
		activity: act,
	});
	const transport = carrier.transportFactory({ doc: new Y.Doc(), vaultId: "v1", isLocalStoreOrigin: () => false });
	if (!(transport instanceof DriveTransport)) throw new Error("expected a DriveTransport");
	const opts = () => Reflect.get(transport, "opts") as { batchMs: number; reconcileIntervalMs: number };
	s.check(transport.nextPollDelayMs() === 3000 && opts().batchMs === 2000 && opts().reconcileIntervalMs === 300_000, "default settings: unchanged numbers");
	act.fire("hidden");
	s.check(transport.nextPollDelayMs() === 120_000, "default settings: hidden desktop 120 s");
	act.fire("visible");

	settings = { ...settings, syncPace: "gentle" };
	carrier.applyPace();
	s.check(transport.nextPollDelayMs() === 10_000 && opts().batchMs === 5000 && opts().reconcileIntervalMs === 600_000, "after choosing Gentle the running transport slows down");
	act.fire("hidden");
	s.check(transport.nextPollDelayMs() === 300_000, "hidden desktop uses the gentle value");
	act.fire("visible");

	settings = { ...settings, syncPace: "custom", syncPaceCustom: { driveActiveSec: 45 } };
	carrier.applyPace();
	s.check(transport.nextPollDelayMs() === 45_000, "custom value is applied live");

	delete settings.syncPace;
	carrier.applyPace();
	s.check(transport.nextPollDelayMs() === 3000 && opts().batchMs === 2000, "back to normal restores today's numbers");
	transport.destroy();
	let threw = false;
	try { carrier.applyPace(); } catch { threw = true; }
	s.check(!threw, "applying after a transport was destroyed does not throw");

	// A new transport (plugin reload) starts with the saved speed.
	settings = { ...settings, syncPace: "minimal" };
	const later = carrier.transportFactory({ doc: new Y.Doc(), vaultId: "v1", isLocalStoreOrigin: () => false });
	s.check(later instanceof DriveTransport && later.nextPollDelayMs() === 30_000, "a new transport starts at the saved speed");
	later.destroy();

	// Explicit overrides (tests, tools) keep priority over the setting.
	const forced = createDriveCarrier({
		getSettings: () => ({ ...settings, syncPace: "minimal" }),
		http: (async () => { throw new Error("no network"); }) as never,
		log: () => {}, onSignInLost: () => {}, isMobile: () => false, activity: new FakeActivity(), pollIntervalMs: 500,
	});
	const t3 = forced.transportFactory({ doc: new Y.Doc(), vaultId: "v2", isLocalStoreOrigin: () => false });
	s.check(t3 instanceof DriveTransport && t3.nextPollDelayMs() === 500, "an explicit poll override still wins");
	t3.destroy();
}

s.section("Test 5: the settings screen");
{
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, carrier: "drive", driveRefreshToken: "r", driveClientId: "i", driveClientSecret: "x" };
	const applied: string[] = [];
	const reasons: string[] = [];
	const host: VaultSyncSettingsHost = {
		settings, serverAuthMode: "claim", serverSupportsAttachments: true, serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: async (mutator, reason) => { mutator(settings); reasons.push(reason ?? ""); },
		refreshServerCapabilities: async () => {}, refreshUpdateManifest: async () => {}, refreshAttachmentSyncRuntime: async () => {},
		getSettingsStatusSummary: () => ({ state: "connected", label: "Connected" }),
		getUpdateState: () => ({ serverVersion: null, latestServerVersion: null, serverUpdateAvailable: false, pluginVersion: "2.0.0", latestPluginVersion: null, pluginUpdateRecommended: false, updateRepoUrl: null, updateActionUrl: null, updateBootstrapUrl: null, legacyServerDetected: false, pluginCompatibilityWarning: null }),
		buildSetupDeepLink: () => null, buildMobileSetupUrl: () => null, buildRecoveryKitText: () => null,
		applySyncPace: () => { applied.push(settings.syncPace ?? "normal"); },
	};
	const tab = new VaultSyncSettingTab(new App(), Object.create(Plugin.prototype) as Plugin, host);
	const flat = (items: SettingDefinitionItem[]): SettingDefinition[] => items.flatMap((i) => "type" in i ? flat(i.items ?? []) : [i]);
	const defs = () => tab.getSettingDefinitions() as SettingDefinitionItem[];
	const headings = defs().flatMap((i) => "type" in i && i.type === "group" && typeof i.heading === "string" ? [i.heading] : []);
	s.check(headings.includes("Sync speed (Google Drive)"), "Drive mode has a Sync speed group");
	const row = (name: string) => flat(defs()).find((d) => d.name === name);
	const isVisible = (d: SettingDefinition | undefined) => d !== undefined && (typeof d.visible === "function" ? d.visible() : d.visible !== false);
	s.check(tab.getControlValue("syncPace") === "normal", "shows Normal when nothing is stored");
	s.check(!isVisible(row("Check while working (seconds)")) && isVisible(row("Current speed")), "number fields are hidden unless Custom");

	await tab.setControlValue("syncPace", "gentle");
	s.check(settings.syncPace === "gentle" && applied.at(-1) === "gentle", "choosing Gentle is saved and applied at once");
	s.check(String(row("Current speed")?.desc).includes("every 10 s while you work"), "the description states the speed in effect");
	await tab.setControlValue("syncPace", "custom");
	s.check(isVisible(row("Check while working (seconds)")) && !isVisible(row("Current speed")), "Custom shows the number fields");
	s.check(tab.getControlValue("drivePaceActive") === 3, "custom fields start from today's numbers");
	await tab.setControlValue("drivePaceActive", 25);
	await tab.setControlValue("drivePaceHidden", 0);
	s.check(settings.syncPaceCustom?.driveActiveSec === 25 && settings.syncPaceCustom?.driveHiddenSec === 0, "custom numbers are saved");
	s.check(tab.getControlValue("drivePaceActive") === 25 && tab.getControlValue("drivePaceHidden") === 0, "and read back");
	let rejected = 0;
	for (const [k, v] of [["drivePaceActive", 1], ["drivePaceActive", 2.5], ["drivePaceBatch", 1], ["drivePaceHidden", 60], ["drivePaceFullCheck", 9999], ["drivePaceIdle", Number.NaN]] as const) {
		try { await tab.setControlValue(k, v); } catch { rejected += 1; }
	}
	s.check(rejected === 6 && settings.syncPaceCustom?.driveActiveSec === 25, "values faster than the default or not whole numbers are refused");
	let badProfile = false;
	try { await tab.setControlValue("syncPace", "turbo"); } catch { badProfile = true; }
	s.check(badProfile && settings.syncPace === "custom", "an unknown speed is refused");
	await tab.setControlValue("syncPace", "normal");
	s.check(!("syncPace" in settings) && applied.at(-1) === "normal", "choosing Normal stores nothing again");
	s.check(reasons.every((r) => r.startsWith("settings:sync-pace")), "only the pace settings were written");

	// Cloudflare mode: no Drive speed group; one dropdown and one number in Advanced, only once a server is set up.
	const cf: VaultSyncSettings = { ...DEFAULT_SETTINGS, host: "https://sync.example", token: "tok", vaultId: "vid" };
	const cfApplied: string[] = [];
	const tab2 = new VaultSyncSettingTab(new App(), Object.create(Plugin.prototype) as Plugin, { ...host, settings: cf, updateSettings: async (mutator) => { mutator(cf); }, applySyncPace: () => { cfApplied.push("applied"); } });
	const cfDefs = tab2.getSettingDefinitions() as SettingDefinitionItem[];
	const h2 = cfDefs.flatMap((i) => "type" in i && i.type === "group" && typeof i.heading === "string" ? [i.heading] : []);
	s.check(!h2.includes("Sync speed (Google Drive)"), "Cloudflare mode does not show the Drive speed group");
	const cfRow = (name: string) => flat(cfDefs).find((d) => d.name === name);
	s.check(cfRow("Sync speed (Cloudflare)")?.control?.key === "syncPace", "the Cloudflare dropdown uses the same setting");
	s.check(!isVisible(cfRow("Group edits for (seconds)")), "its number field is hidden unless Custom");
	await tab2.setControlValue("syncPace", "minimal");
	s.check(cf.syncPace === "minimal" && cfApplied.length === 1, "choosing Minimal is saved and applied");
	await tab2.setControlValue("syncPace", "custom");
	await tab2.setControlValue("cloudflarePaceBatch", 8);
	s.check(cf.syncPaceCustom?.cloudflareBatchSec === 8 && tab2.getControlValue("cloudflarePaceBatch") === 8, "custom seconds are saved and read back");
	await tab2.setControlValue("cloudflarePaceBatch", 0);
	s.check(cf.syncPaceCustom?.cloudflareBatchSec === 0, "0 (send at once) is allowed");
	let cfRejected = 0;
	for (const v of [0.5, -1, 31, 2.5, Number.NaN]) {
		try { await tab2.setControlValue("cloudflarePaceBatch", v); } catch { cfRejected += 1; }
	}
	s.check(cfRejected === 5 && cf.syncPaceCustom?.cloudflareBatchSec === 0, "values outside 0 or 1 to 30 are refused");
	const unconfigured = new VaultSyncSettingTab(new App(), Object.create(Plugin.prototype) as Plugin, { ...host, settings: { ...DEFAULT_SETTINGS } });
	s.check(!flat(unconfigured.getSettingDefinitions() as SettingDefinitionItem[]).some((d) => d.control?.key === "syncPace"), "before a server is set up the screen is exactly as before (no speed rows)");
}

await s.done();
