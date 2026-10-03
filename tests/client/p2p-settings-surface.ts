/**
 * Phase 0 P2P spike — settings surface (Milestone B2 redesign).
 *
 * Verifies the plan §8 settings shape after the redesign: the P2P surface is
 * visible ONLY while the P2P carrier is selected (dormant for every other
 * carrier); the layout is carrier row + custom P2P home page (pairing path)
 * + navigable Advanced sub-page (technical controls, buttonified network
 * check); the TURN fields persist and push to the spike host; and the
 * settings keys have safe defaults.
 */
import { App, Plugin, SettingPage, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import {
	DEFAULT_SETTINGS,
	readVaultSyncSettings,
	type VaultSyncSettings,
} from "../../src/settings/settingsStore";
import {
	VaultSyncSettingTab,
	type VaultSyncSettingsHost,
} from "../../src/settings/settingsTab";
import type { TurnOverride } from "../../src/p2p/spikeHost";
import { suite } from "../harness.ts";

const s = suite("p2p-settings-surface");

function collectDefinitions(items: SettingDefinitionItem[]): SettingDefinition[] {
	const definitions: SettingDefinition[] = [];
	for (const item of items) {
		if ("type" in item) {
			if (item.items) definitions.push(...collectDefinitions(item.items));
			continue;
		}
		definitions.push(item);
	}
	return definitions;
}

interface Fixture {
	tab: VaultSyncSettingTab;
	host: VaultSyncSettingsHost;
	settings: VaultSyncSettings;
	updateReasons: string[];
	p2pCalls: string[];
	turnApplied: TurnOverride[][];
}

function createFixture(settings: Partial<VaultSyncSettings> = {}): Fixture {
	// The P2P surface exists only while the P2P carrier is selected, so the
	// default fixture selects it; dormancy checks pass another carrier.
	const base: VaultSyncSettings = { carrier: "p2p", ...DEFAULT_SETTINGS, ...settings };
	const updateReasons: string[] = [];
	const p2pCalls: string[] = [];
	const turnApplied: TurnOverride[][] = [];
	const host: VaultSyncSettingsHost = {
		settings: base,
		serverAuthMode: "claim",
		serverSupportsAttachments: true,
		serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: async (mutator, reason) => {
			mutator(base);
			updateReasons.push(reason ?? "");
		},
		refreshServerCapabilities: async () => {},
		refreshUpdateManifest: async () => {},
		refreshAttachmentSyncRuntime: async () => {},
		getSettingsStatusSummary: () => ({ state: "connected", label: "Connected" }),
		getUpdateState: () => ({
			serverVersion: "0.3.0",
			latestServerVersion: "0.3.0",
			serverUpdateAvailable: false,
			pluginVersion: "2.0.0",
			latestPluginVersion: "2.0.0",
			pluginUpdateRecommended: false,
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			legacyServerDetected: false,
			pluginCompatibilityWarning: null,
		}),
		buildSetupDeepLink: () => null,
		buildMobileSetupUrl: () => null,
		buildRecoveryKitText: () => null,
		getP2pPeerSummary: () => "1 peer — direct · last seen 10:00:00",
		openP2pPanel: () => {
			p2pCalls.push("panel-opened");
		},
		runP2pNetworkCheck: () => {
			p2pCalls.push("network-check");
		},
		applyP2pTurn: () => {
			turnApplied.push([
				{
					url: base.p2pTurnUrl,
					username: base.p2pTurnUsername || undefined,
					credential: base.p2pTurnCredential || undefined,
				},
			]);
		},
	};
	const plugin = Object.create(Plugin.prototype) as Plugin;
	const tab = new VaultSyncSettingTab(new App(), plugin, host);
	return { tab, host, settings: base, updateReasons, p2pCalls, turnApplied };
}

interface P2pRow {
	name: string;
	desc?: string;
	action?: () => void;
	/** Per-row DOM hook (the declarative API's buttonification mechanism). */
	render?: (setting: { settingEl: { createEl(tag: string, opts?: { text?: string; cls?: string }): { addEventListener(ev: string, cb: () => void): void } } }) => void;
	control?: { type: string; key: string };
}

/** The custom "P2P (experimental)" home page (null when not on the P2P carrier). */
function p2pHomePage(tab: VaultSyncSettingTab): { type?: string; name: string; desc?: string; page?: () => unknown } | null {
	const items = tab.getSettingDefinitions();
	for (const item of items) {
		if ("type" in item && item.type === "page" && item.name === "P2P (experimental)") {
			return item as { type?: string; name: string; desc?: string; page?: () => unknown };
		}
	}
	return null;
}

/** The rows of the navigable "Advanced" sub-page (empty when not on the P2P carrier). */
function p2pAdvancedRows(tab: VaultSyncSettingTab): P2pRow[] {
	const items = tab.getSettingDefinitions();
	for (const item of items) {
		if ("type" in item && item.type === "page" && item.name === "Advanced" && item.items) {
			return item.items as P2pRow[];
		}
	}
	return [];
}

s.section("1: home page visible only while the P2P carrier is selected");
{
	// P2P carrier: carrier row + custom home page + navigable Advanced page.
	const p2p = createFixture({ host: "https://x.example", token: "t" });
	const home = p2pHomePage(p2p.tab);
	const advanced = p2pAdvancedRows(p2p.tab);
	s.check(home !== null, "custom P2P home page present with the P2P carrier selected");
	s.check(
		p2p.tab.getSettingDefinitions().length === 3 && advanced.length === 6,
		"the P2P tab is carrier row + home page + Advanced page",
	);
	s.check(home?.type === "page" && typeof home?.page === "function", "the home page is a custom SettingPage (factory), not flat rows");
	s.check(home?.page?.() instanceof SettingPage, "the home page factory constructs a SettingPage instance");
	if (advanced.length) {
		const names = advanced.map((g) => g.name);
		s.check(names.includes("Backbone (optional)"), "backbone row present (Advanced)");
		s.check(
			advanced.some((g) => g.name === "Backbone (optional)" && /Phase 1/.test(g.desc ?? "")),
			"backbone row honestly marks Phase 1 options",
		);
		s.check(names.includes("P2P network check"), "network check present (Advanced)");
		s.check(names.includes("Debug mode"), "debug toggle present (Advanced)");
	}

	// Every other carrier: the whole P2P surface is dormant.
	s.check(p2pHomePage(createFixture({ carrier: "cloudflare" }).tab) === null, "no P2P home page on the Cloudflare (default) layout");
	s.check(p2pHomePage(createFixture({ host: "", token: "", carrier: "drive", driveClientId: "c" }).tab) === null, "no P2P home page on the Drive layout");
}

s.section("2: TURN fields persist and push to the spike");
{
	const { tab, settings, updateReasons, turnApplied } = createFixture();
	s.check(tab.getControlValue("p2pTurnUrl") === "", "TURN URL defaults to empty");
	s.check(tab.getControlValue("p2pTurnUsername") === "", "TURN username defaults to empty");
	s.check(tab.getControlValue("p2pTurnCredential") === "", "TURN credential defaults to empty");

	s.test("TURN writes persist, apply, and read back", async () => {
		await tab.setControlValue("p2pTurnUrl", " turn:relay.example:3478 ");
		await tab.setControlValue("p2pTurnUsername", "alice");
		s.check(settings.p2pTurnUrl === "turn:relay.example:3478", "TURN URL persisted and trimmed");
		s.check(settings.p2pTurnUsername === "alice", "TURN username persisted");
		s.check(tab.getControlValue("p2pTurnUrl") === "turn:relay.example:3478", "value reads back");
		s.check(
			updateReasons.filter((r) => r === "settings:p2p-turn").length === 2,
			"both writes use the settings:p2p-turn reason",
		);
		s.check(turnApplied.length === 2, "applyP2pTurn called on every TURN write");
		s.check(
			turnApplied[1]![0]?.url === "turn:relay.example:3478" && turnApplied[1]![0]?.username === "alice",
			"pushed override matches the saved fields",
		);
	});
}

s.section("3: buttonified network check and peer summary source");
{
	const { tab, p2pCalls } = createFixture();
	const home = p2pHomePage(tab);
	const advanced = p2pAdvancedRows(tab);
	s.check(home !== null, "home page present for wiring checks");
	const checkRow = advanced.find((g) => g.name === "P2P network check");
	s.check(typeof checkRow?.render === "function", "network check row uses the render hook (a visible button, not an action row)");
	const clicks: Array<() => void> = [];
	let buttonLabel: string | null = null;
	checkRow?.render?.({
		settingEl: {
			createEl: (tag, opts) => {
				if (tag === "button") buttonLabel = opts?.text ?? null;
				return {
					addEventListener: (_ev, cb) => { clicks.push(cb); },
				};
			},
		},
	});
	s.check(buttonLabel === "Run check", `the render hook builds a labeled button (${buttonLabel ?? "none"})`);
	clicks[0]?.();
	s.check(p2pCalls.includes("network-check"), "clicking the button runs the network check");
}

s.section("4: defaults and hosts without the spike");
{
	const { settings } = readVaultSyncSettings(undefined);
	s.check(settings.p2pTurnUrl === "" && settings.p2pTurnUsername === "" && settings.p2pTurnCredential === "", "new keys default to empty");
	const { settings: persisted } = readVaultSyncSettings({ p2pTurnUrl: "turn:h:3478" });
	s.check(persisted.p2pTurnUrl === "turn:h:3478", "persisted TURN value survives the merge");

	// A host without the P2P methods (e.g. future/other hosts) still renders
	// the home page (P2P carrier selected) — the page factory must construct
	// without spike access.
	const base: VaultSyncSettings = { carrier: "p2p", ...DEFAULT_SETTINGS };
	const host: VaultSyncSettingsHost = {
		settings: base,
		serverAuthMode: "unclaimed",
		serverSupportsAttachments: false,
		serverMaxBlobUploadBytes: null,
		updateSettings: async () => {},
		refreshServerCapabilities: async () => {},
		refreshUpdateManifest: async () => {},
		refreshAttachmentSyncRuntime: async () => {},
		getSettingsStatusSummary: () => ({ state: "disconnected", label: "Disconnected" }),
		getUpdateState: () => ({
			serverVersion: null,
			latestServerVersion: null,
			serverUpdateAvailable: false,
			pluginVersion: "2.0.0",
			latestPluginVersion: null,
			pluginUpdateRecommended: false,
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			legacyServerDetected: false,
			pluginCompatibilityWarning: null,
		}),
		buildSetupDeepLink: () => null,
		buildMobileSetupUrl: () => null,
		buildRecoveryKitText: () => null,
	};
	const tab = new VaultSyncSettingTab(new App(), Object.create(Plugin.prototype) as Plugin, host);
	const home = p2pHomePage(tab);
	s.check(home !== null, "home page renders without spike host methods");
	s.check(home?.page?.() instanceof SettingPage, "home page constructs without spike host methods");
}

await s.done();
