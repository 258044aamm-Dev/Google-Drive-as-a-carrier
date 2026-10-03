/**
 * Phase 0 P2P spike — settings surface ("P2P (experimental)" group).
 *
 * Verifies the plan §8 settings shape: the group is visible ONLY while the
 * P2P carrier is selected (dormant for every other carrier), the carrier
 * row leads the group, the TURN fields persist and push to the spike host,
 * the peer summary and action rows are wired, and the settings keys have
 * safe defaults.
 */
import { App, Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
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
	control?: { type: string; key: string };
}

function p2pGroup(tab: VaultSyncSettingTab): P2pRow[] | null {
	const items = tab.getSettingDefinitions();
	for (const item of items) {
		if ("type" in item && item.heading === "P2P (experimental)" && item.items) {
			return item.items as P2pRow[];
		}
	}
	return null;
}

s.section("1: group visible only while the P2P carrier is selected");
{
	// P2P carrier: the tab is exactly the P2P group, carrier row first.
	const p2p = createFixture({ host: "https://x.example", token: "t" });
	const group = p2pGroup(p2p.tab);
	s.check(group !== null, "P2P group present with the P2P carrier selected");
	s.check(
		p2p.tab.getSettingDefinitions().length === 1
			&& p2p.tab.getSettingDefinitions()[0]!.heading === "P2P (experimental)",
		"the P2P tab contains nothing but the P2P group",
	);
	if (group) {
		const names = group.map((g) => g.name);
		s.check(names[0] === "Sync carrier (experimental)", "carrier row leads the group, so switching back is one tap away");
		s.check(names.includes("Direct P2P link"), "direct link row present");
		s.check(names.includes("This vault"), "peer row present");
		s.check(names.includes("Backbone (optional)"), "backbone row present");
		s.check(
			group.some((g) => g.name === "Backbone (optional)" && /Phase 1/.test(g.desc ?? "")),
			"backbone row honestly marks Phase 1 options",
		);
		s.check(names.includes("Pair another device (QR + code)"), "pair action present");
		s.check(names.includes("P2P network check"), "network check present");
	}

	// Every other carrier: the whole P2P surface is dormant.
	s.check(p2pGroup(createFixture({ carrier: "cloudflare" }).tab) === null, "no P2P group on the Cloudflare (default) layout");
	s.check(p2pGroup(createFixture({ host: "", token: "", carrier: "drive", driveClientId: "c" }).tab) === null, "no P2P group on the Drive layout");
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

s.section("3: action rows and peer summary wiring");
{
	const { tab, p2pCalls } = createFixture();
	const group = p2pGroup(tab);
	s.check(group !== null, "group present for wiring checks");
	if (group) {
		const peer = group.find((g) => g.name === "This vault");
		s.check(peer?.desc === "1 peer — direct · last seen 10:00:00", "peer row shows the host summary");
		group.find((g) => g.name === "Pair another device (QR + code)")?.action?.();
		s.check(p2pCalls.filter((c) => c === "panel-opened").length === 1, "pair row opens the panel");
		group.find((g) => g.name === "P2P network check")?.action?.();
		s.check(p2pCalls.includes("network-check"), "check row runs the network check");
	}
}

s.section("4: defaults and hosts without the spike");
{
	const { settings } = readVaultSyncSettings(undefined);
	s.check(settings.p2pTurnUrl === "" && settings.p2pTurnUsername === "" && settings.p2pTurnCredential === "", "new keys default to empty");
	const { settings: persisted } = readVaultSyncSettings({ p2pTurnUrl: "turn:h:3478" });
	s.check(persisted.p2pTurnUrl === "turn:h:3478", "persisted TURN value survives the merge");

	// A host without the P2P methods (e.g. future/other hosts) still renders
	// the group (P2P carrier selected).
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
	const group = p2pGroup(tab);
	s.check(group !== null, "group renders without spike host methods");
	const peer = group?.find((g) => g.name === "This vault");
	s.check(peer?.desc === "No P2P link yet.", "peer row falls back to the neutral text");
}

await s.done();
