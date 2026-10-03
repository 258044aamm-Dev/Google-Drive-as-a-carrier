/**
 * Simple status: the short bottom-bar text, the header icon, and their settings.
 * The long technical labels (status-label.ts) are not touched by any of this.
 */

import { App, Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type { ConnectionState } from "../../src/runtime/connectionController";
import { HeaderStatusIcons, type HeaderActionElement, type HeaderView } from "../../src/status/headerStatusIcons";
import {
	STATUS_ICONS,
	clearSimpleStatusClasses,
	isDetailedStatusShown,
	isStatusIconShown,
	renderSimpleStatusBar,
	toSimpleStatus,
	type SimpleStatus,
	type SimpleStatusLevel,
} from "../../src/status/simpleStatus";
import { getLabelFromConnectionState } from "../../src/status/statusBarController";
import { DEFAULT_SETTINGS, readVaultSyncSettings, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { VaultSyncSettingTab, type VaultSyncSettingsHost } from "../../src/settings/settingsTab";
import { suite } from "../harness.ts";

const s = suite("status-simple");

const online: ConnectionState = { kind: "online", generation: 1 };
const offline: ConnectionState = { kind: "offline", reason: "network_offline", generation: 1 };
const levelOf = (state: ConnectionState | undefined, extra: Partial<Parameters<typeof toSimpleStatus>[0]> = {}): SimpleStatus =>
	toSimpleStatus({ state, coarse: "connected", attentionCount: 0, ...extra });

s.section("Test 1: the words and levels");
{
	s.check(levelOf(online).level === "ok" && levelOf(online).text === "Synced", "connected = Synced");
	s.check(levelOf({ kind: "connecting" }).level === "busy" && levelOf({ kind: "connecting" }).text === "Connecting…", "connecting");
	s.check(levelOf({ kind: "loading_cache" }).level === "busy", "loading the cache is busy");
	s.check(levelOf(offline).level === "offline" && levelOf(offline).text === "Offline" && /saved on this device/.test(levelOf(offline).detail), "offline says edits are saved here");
	s.check(levelOf({ kind: "disconnected" }).text === "Not connected", "disconnected");
	for (const code of ["unauthorized", "server_misconfigured", "unclaimed"] as const) {
		s.check(levelOf({ kind: "auth_failed", code }).level === "error" && levelOf({ kind: "auth_failed", code }).text === "Sign-in problem", `auth ${code} = Sign-in problem`);
	}
	s.check(levelOf({ kind: "server_update_required", details: null } as ConnectionState).text === "Update needed", "update required");
	s.check(levelOf(online, { attentionCount: 1 }).text === "Check 1 file" && levelOf(online, { attentionCount: 3 }).text === "Check 3 files", "attention count, singular and plural");
	s.check(levelOf(online, { attentionCount: 1 }).level === "attention", "attention level");
	s.check(levelOf(online, { transferStatus: "↑2" }).level === "busy" && levelOf(online, { transferStatus: "↑2" }).text === "Syncing…", "attachments moving = Syncing");
	const waiting = { serverAppliedLocalState: false, lastServerReceiptEchoAt: null, lastKnownServerReceiptEchoAt: 5, candidatePersistenceHealthy: true, serverReceiptStartupValidation: null };
	s.check(levelOf(online, { receipt: waiting }).level === "busy", "an edit awaiting confirmation is calm 'Syncing', not a warning");
	const unknown = { ...waiting, serverAppliedLocalState: null };
	s.check(levelOf(online, { receipt: unknown }).level === "ok", "receipt not tracked yet stays Synced");
	const notSaving = { ...waiting, serverAppliedLocalState: true, serverPersistenceDegraded: true };
	s.check(levelOf(online, { receipt: notSaving }).level === "attention" && levelOf(online, { receipt: notSaving }).text === "Not saving", "server not saving is a warning");
	s.check(levelOf(online, { receipt: notSaving, attentionCount: 4 }).text === "Not saving", "ranked ahead of file attention");
	s.check(levelOf({ kind: "auth_failed", code: "unauthorized" }, { attentionCount: 4, receipt: notSaving }).level === "error", "an error outranks everything");
	s.check(levelOf(offline, { attentionCount: 2 }).level === "attention", "files needing attention show even while offline");
	// Before the connection controller exists.
	for (const [coarse, level] of [["connected", "ok"], ["offline", "offline"], ["disconnected", "offline"], ["loading", "busy"], ["syncing", "busy"], ["error", "error"], ["unauthorized", "error"]] as const) {
		s.check(toSimpleStatus({ state: undefined, coarse, attentionCount: 0 }).level === level, `no connection state: ${coarse} -> ${level}`);
	}
	const all = new Set<string>();
	for (const st of [online, offline, { kind: "connecting" } as ConnectionState, { kind: "disconnected" } as ConnectionState]) all.add(levelOf(st).text);
	s.check([...all].every((t) => t.length <= 14), "the words are short");
	s.check((Object.keys(STATUS_ICONS) as SimpleStatusLevel[]).length === 5 && new Set(Object.values(STATUS_ICONS)).size === 5, "five levels, five different icon shapes");
}

s.section("Test 2: the bottom bar");
{
	class El {
		text = ""; attrs: Record<string, string> = {}; classes = new Set<string>();
		setText(t: string) { this.text = t; }
		setAttr(n: string, v: string) { this.attrs[n] = v; }
		toggleClass(c: string, on: boolean) { if (on) this.classes.add(c); else this.classes.delete(c); }
	}
	const el = new El();
	const detailed = getLabelFromConnectionState(online, null, null, 2);
	renderSimpleStatusBar(el, levelOf(online, { attentionCount: 2 }), detailed);
	s.check(el.text === "YAOS: Check 2 files", "short text");
	s.check(el.attrs.title?.includes("Details: YAOS: Connected · 2 files need attention") === true, "the long label is in the tooltip");
	s.check(el.classes.has("yaos-status-attention") && el.classes.size === 1, "one colour class");
	renderSimpleStatusBar(el, levelOf(online), detailed);
	s.check(el.text === "YAOS: Synced" && el.classes.size === 1 && el.classes.has("yaos-status-ok"), "the class follows the level");
	clearSimpleStatusClasses(el);
	s.check(el.classes.size === 0, "classes can be cleared for the detailed text");
	s.check(getLabelFromConnectionState(online, null, null, 0) === "YAOS: Connected", "the detailed label function is unchanged");
}

s.section("Test 3: the header icons");
{
	interface FakeEl extends HeaderActionElement { removed: boolean; attrs: Record<string, string>; classes: Set<string>; icon: string }
	const created: FakeEl[] = [];
	const makeView = (): HeaderView => ({
		addAction: (icon) => {
			const el: FakeEl = {
				removed: false, attrs: {}, classes: new Set(), icon,
				setAttr(n, v) { this.attrs[n] = v; },
				toggleClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); },
				remove() { this.removed = true; },
			};
			created.push(el);
			return el;
		},
	});
	const clicks: number[] = [];
	let iconCalls = 0;
	const icons = new HeaderStatusIcons({
		setIcon: (el, icon) => { iconCalls += 1; (el as FakeEl).icon = icon; },
		onClick: () => { clicks.push(1); },
	});
	const v1 = makeView();
	const v2 = makeView();
	icons.sync([v1, v2]);
	s.check(created.length === 2 && icons.count === 2, "one icon per open note view");
	icons.sync([v1, v2]);
	s.check(created.length === 2, "syncing again adds nothing twice");
	icons.update({ level: "ok", text: "Synced", detail: "d" });
	s.check(created.every((e) => e.icon === "check" && e.attrs["aria-label"] === "YAOS: Synced" && e.classes.has("yaos-status-ok")), "both are painted");
	const before = iconCalls;
	icons.update({ level: "ok", text: "Synced", detail: "d" });
	s.check(iconCalls === before, "an unchanged status does not touch the DOM");
	icons.update({ level: "offline", text: "Offline", detail: "x" });
	s.check(created[0]!.icon === "cloud-off" && created[0]!.classes.has("yaos-status-offline") && !created[0]!.classes.has("yaos-status-ok"), "a changed status repaints and swaps the class");
	const v3 = makeView();
	icons.sync([v2, v3]);
	s.check(created[0]!.removed && !created[1]!.removed && icons.count === 2, "a closed view's icon is dropped");
	s.check(created[2]!.icon === "cloud-off" && created[2]!.attrs["aria-label"] === "YAOS: Offline", "a new view starts with the current status");
	icons.setEnabled(false);
	s.check(created.every((e) => e.removed) && icons.count === 0, "switching off removes every icon");
	icons.sync([v2, v3]);
	s.check(icons.count === 0, "and none come back while it is off");
	icons.setEnabled(true);
	icons.sync([v2, v3]);
	s.check(icons.count === 2 && created.length === 5, "switching on adds them again");
	icons.dispose();
	s.check(icons.count === 0 && created.slice(3).every((e) => e.removed), "dispose removes everything");
	void clicks;
}

s.section("Test 4: the settings");
{
	s.check(isStatusIconShown({}) && !isDetailedStatusShown({}), "defaults: icon on, short text");
	s.check(!isStatusIconShown({ showStatusIcon: false }) && isDetailedStatusShown({ detailedStatus: true }), "explicit values");
	s.check(!("showStatusIcon" in DEFAULT_SETTINGS) && !("detailedStatus" in DEFAULT_SETTINGS), "nothing is stored by default");
	const kept = readVaultSyncSettings({ syncPace: "gentle", syncPaceCustom: { driveActiveSec: 20 }, showStatusIcon: false, detailedStatus: true }).settings;
	s.check(kept.syncPace === "gentle" && kept.syncPaceCustom?.driveActiveSec === 20 && kept.showStatusIcon === false && kept.detailedStatus === true, "the new settings survive loading");
	s.check(!("syncPace" in readVaultSyncSettings({}).settings), "an old user's data gets none of them");

	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS };
	const applied: string[] = [];
	const host: VaultSyncSettingsHost = {
		settings, serverAuthMode: "claim", serverSupportsAttachments: true, serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: async (mutator) => { mutator(settings); },
		refreshServerCapabilities: async () => {}, refreshUpdateManifest: async () => {}, refreshAttachmentSyncRuntime: async () => {},
		getSettingsStatusSummary: () => ({ state: "connected", label: "Connected" }),
		getUpdateState: () => ({ serverVersion: null, latestServerVersion: null, serverUpdateAvailable: false, pluginVersion: "2.0.0", latestPluginVersion: null, pluginUpdateRecommended: false, updateRepoUrl: null, updateActionUrl: null, updateBootstrapUrl: null, legacyServerDetected: false, pluginCompatibilityWarning: null }),
		buildSetupDeepLink: () => null, buildMobileSetupUrl: () => null, buildRecoveryKitText: () => null,
		applyStatusDisplay: () => { applied.push("applied"); },
	};
	const tab = new VaultSyncSettingTab(new App(), Object.create(Plugin.prototype) as Plugin, host);
	const flat = (items: SettingDefinitionItem[]): SettingDefinition[] => items.flatMap((i) => "type" in i ? flat(i.items ?? []) : [i]);
	for (const mode of ["cloudflare", "drive"] as const) {
		const t = new VaultSyncSettingTab(new App(), Object.create(Plugin.prototype) as Plugin, { ...host, settings: { ...DEFAULT_SETTINGS, carrier: mode } });
		const defs = flat(t.getSettingDefinitions() as SettingDefinitionItem[]);
		s.check(defs.filter((d) => d.control?.key === "showStatusIcon").length === 1 && defs.filter((d) => d.control?.key === "detailedStatus").length === 1, `${mode}: both switches appear once`);
	}
	s.check(tab.getControlValue("showStatusIcon") === true && tab.getControlValue("detailedStatus") === false, "the switches show the defaults");
	await tab.setControlValue("showStatusIcon", false);
	s.check(settings.showStatusIcon === false && applied.length === 1, "icon off is saved and applied at once");
	await tab.setControlValue("showStatusIcon", true);
	s.check(!("showStatusIcon" in settings) && applied.length === 2, "icon on stores nothing again");
	await tab.setControlValue("detailedStatus", true);
	s.check(settings.detailedStatus === true && tab.getControlValue("detailedStatus") === true && applied.length === 3, "detailed text on");
	await tab.setControlValue("detailedStatus", false);
	s.check(!("detailedStatus" in settings), "detailed text off stores nothing again");
	let bad = 0;
	for (const k of ["showStatusIcon", "detailedStatus"]) { try { await tab.setControlValue(k, "yes"); } catch { bad += 1; } }
	s.check(bad === 2, "a non-boolean is refused");
}

await s.done();
