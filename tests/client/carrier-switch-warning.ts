/**
 * COD-8: switching the sync carrier has to be a choice the user sees coming.
 *
 * Before this, the carrier row saved first and raised one reload toast after
 * the fact, and two failure paths said nothing at all. These checks pin the
 * new behaviour: ask before saving, never fail in silence, and say what the
 * switch actually does.
 *
 * The confirmation is reached through the settings host rather than a modal
 * created inside the tab, so it can be driven here without a DOM — the same
 * reason the tab never imports ConfirmModal itself.
 */
import { App, Plugin } from "obsidian";
import * as obsidian from "obsidian";
import {
	VaultSyncSettingTab,
	carrierSwitchMessage,
	type CarrierSwitchRequest,
	type VaultSyncSettingsHost,
} from "../../src/settings/settingsTab.ts";
import {
	DEFAULT_SETTINGS,
	type VaultSyncSettings,
} from "../../src/settings/settingsStore.ts";
import type { CarrierKind } from "../../src/drive-carrier/carrierSettings.ts";
import { suite } from "../harness.ts";

const s = suite("carrier-switch-warning");

/** Every notice the product code raised, in order. */
const notices: string[] = [];
Object.assign(obsidian, {
	Notice: class {
		constructor(message: string) {
			notices.push(message);
		}
	},
});

interface FixtureOptions {
	from: CarrierKind;
	/** What the confirmation answers. Undefined = the host offers no confirmation at all. */
	confirm?: boolean;
	lanAvailable?: boolean;
	failPrepare?: boolean;
	failSave?: boolean;
	driveSignedIn?: boolean;
}

interface Fixture {
	tab: VaultSyncSettingTab;
	settings: VaultSyncSettings;
	requests: CarrierSwitchRequest[];
	updateReasons: string[];
	prepareCalls: number;
	wizardOpens: number;
}

function createFixture(options: FixtureOptions): Fixture {
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS };
	settings.carrier = options.from;
	settings.host = "https://sync.example.com";
	settings.token = "token";
	settings.vaultId = "vault";
	if (options.driveSignedIn) {
		settings.driveClientId = "client-id";
		settings.driveClientSecret = "client-secret";
		settings.driveRefreshToken = "refresh-token";
	}

	const requests: CarrierSwitchRequest[] = [];
	const updateReasons: string[] = [];
	let prepareCalls = 0;
	let wizardOpens = 0;

	const host: VaultSyncSettingsHost = {
		settings,
		serverAuthMode: "claim",
		serverSupportsAttachments: true,
		serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: async (mutator, reason) => {
			if (options.failSave) throw new Error("saveData failed");
			mutator(settings);
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
			pluginVersion: "2.1.23",
			latestPluginVersion: "2.1.23",
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
		openDriveWizard: () => {
			wizardOpens++;
		},
		lan: {
			available: options.lanAvailable !== false,
			prepare: async () => {
				prepareCalls++;
				if (options.failPrepare) throw new Error("key generation failed");
			},
			status: () => ({
				running: false,
				listening: false,
				port: null,
				error: null,
				discoveryRunning: false,
				fingerprint: "",
				linked: [],
				seen: [],
				refusals: [],
			}),
			copySetupCode: () => {},
			regenerateKey: async () => {},
			forgetDevice: async () => {},
			applyManualPeers: () => {},
		},
	};

	if (options.confirm !== undefined) {
		const answer = options.confirm;
		host.confirmSwitch = async (request) => {
			requests.push(request);
			return answer;
		};
	}

	const tab = new VaultSyncSettingTab(
		new App(),
		Object.create(Plugin.prototype) as Plugin,
		host,
	);
	return {
		tab,
		settings,
		requests,
		updateReasons,
		get prepareCalls() {
			return prepareCalls;
		},
		get wizardOpens() {
			return wizardOpens;
		},
	};
}

async function switchCarrier(
	fixture: Fixture,
	to: CarrierKind,
): Promise<{ threw: boolean }> {
	try {
		await fixture.tab.setControlValue("carrier", to);
		return { threw: false };
	} catch {
		return { threw: true };
	}
}

s.section("The switch is confirmed before anything is saved");
{
	const fixture = createFixture({ from: "cloudflare", confirm: false });
	const result = await switchCarrier(fixture, "drive");
	s.check(fixture.requests.length === 1, "switching asks once before saving");
	s.check(
		fixture.requests[0]?.from === "cloudflare" && fixture.requests[0]?.to === "drive",
		"the request names both the carrier being left and the one being chosen",
	);
	s.check(!result.threw, "declining is not an error");
	s.check(
		fixture.settings.carrier === "cloudflare",
		"declining leaves the carrier untouched",
	);
	s.check(fixture.updateReasons.length === 0, "declining saves nothing");
	s.check(notices.length === 0, "declining says nothing");
}

s.section("Accepting saves the carrier and says a reload is needed");
{
	const fixture = createFixture({ from: "cloudflare", confirm: true });
	const result = await switchCarrier(fixture, "drive");
	s.check(!result.threw, "accepting completes the switch");
	s.check(fixture.settings.carrier === "drive", "the new carrier is saved");
	s.check(
		fixture.updateReasons.includes("settings:carrier"),
		"the save keeps its reason",
	);
	s.check(
		notices.some((message) => message.includes("Reload the plugin")),
		"the user is told a reload is needed",
	);
}

s.section("A host without confirmation still switches");
{
	const fixture = createFixture({ from: "cloudflare" });
	const result = await switchCarrier(fixture, "drive");
	s.check(!result.threw, "a host that does not implement the hook still works");
	s.check(fixture.settings.carrier === "drive", "the carrier is saved as before");
	s.check(
		notices.some((message) => message.includes("Reload the plugin")),
		"and the reload notice still appears",
	);
}

s.section("Failures speak instead of going quiet");
{
	const saved = createFixture({ from: "drive", confirm: true, failSave: true });
	const savedResult = await switchCarrier(saved, "cloudflare");
	s.check(saved.settings.carrier === "drive", "a failed save leaves the carrier alone");
	s.check(
		notices.some((message) => message.includes("was not switched")),
		"a failed save says the carrier was not switched",
	);
	s.check(savedResult.threw, "a failed save still rejects, as it did before");
}
{
	const prepared = createFixture({ from: "cloudflare", confirm: true, failPrepare: true });
	const preparedResult = await switchCarrier(prepared, "lan");
	s.check(prepared.prepareCalls === 1, "the local network preparation still runs");
	s.check(
		notices.some((message) => message.includes("key and certificate")),
		"a failed preparation says what could not be created",
	);
	s.check(preparedResult.threw, "a failed preparation still rejects, as it did before");
}

s.section("Re-picking the selected carrier is a no-op");
{
	const fixture = createFixture({ from: "cloudflare", confirm: true });
	notices.length = 0;
	const result = await switchCarrier(fixture, "cloudflare");
	s.check(!result.threw, "re-picking is not an error");
	s.check(fixture.requests.length === 0, "re-picking asks nothing");
	s.check(notices.length === 0, "re-picking says nothing");
	s.check(fixture.updateReasons.length === 0, "re-picking saves nothing");
}

s.section("The message says what the switch does");
{
	const kinds: CarrierKind[] = ["cloudflare", "drive", "lan"];
	for (const from of kinds) {
		for (const to of kinds) {
			if (from === to) continue;
			const message = carrierSwitchMessage(from, to, {
				driveSignedIn: false,
				lanAvailable: true,
			});
			const label = `${from} -> ${to}`;
			s.check(
				message.includes("not copied between carriers"),
				`${label}: says notes are not copied between carriers`,
			);
			s.check(
				message.includes("this device only"),
				`${label}: says the choice is per device`,
			);
			s.check(
				message.includes("syncing finish"),
				`${label}: says to let syncing finish first`,
			);
			s.check(
				message.includes("reload the plugin"),
				`${label}: says a reload makes it take effect`,
			);
		}
	}
	s.check(
		carrierSwitchMessage("cloudflare", "drive", { driveSignedIn: false, lanAvailable: true })
			.includes("sign in to Google Drive"),
		"Google Drive: an unsigned device is told it will sign in",
	);
	s.check(
		carrierSwitchMessage("cloudflare", "drive", { driveSignedIn: true, lanAvailable: true })
			.includes("passphrase"),
		"Google Drive: a signed-in device is told about the passphrase",
	);
	s.check(
		carrierSwitchMessage("cloudflare", "lan", { driveSignedIn: false, lanAvailable: true })
			.includes("desktop app"),
		"local network: the desktop requirement is named",
	);
}

s.section("Behaviour that must not change");
{
	const fixture = createFixture({ from: "cloudflare", confirm: true });
	await switchCarrier(fixture, "drive");
	s.check(fixture.wizardOpens === 1, "an unsigned device still gets the Drive wizard");
}
{
	const signedIn = createFixture({ from: "cloudflare", confirm: true, driveSignedIn: true });
	await switchCarrier(signedIn, "drive");
	s.check(signedIn.wizardOpens === 0, "a signed-in device is not sent through the wizard");
}

await s.done();
