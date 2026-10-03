/**
 * Drive carrier: choice of carrier in the settings, and the guarantee that
 * choosing nothing changes nothing for existing (Cloudflare) users.
 */

import {
	App,
	Plugin,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
import {
	currentCarrier,
	driveFolderLabel,
	isCarrierKind,
	isDriveCarrier,
	isDriveSignedIn,
	newDriveDeviceId,
} from "../../src/drive-carrier/carrierSettings";
import { createDriveTransportFactory } from "../../src/drive-carrier/driveCarrierRuntime";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import type { DriveHttp, DriveHttpRequest } from "../../src/drive-carrier/googleDriveRest";
import {
	DEFAULT_SETTINGS,
	SettingsStore,
	readVaultSyncSettings,
	type VaultSyncSettings,
} from "../../src/settings/settingsStore";
import {
	VaultSyncSettingTab,
	type VaultSyncSettingsHost,
} from "../../src/settings/settingsTab";
import { registerCommands, type CommandsRuntimeHost } from "../../src/commands";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-settings");

function flatten(items: SettingDefinitionItem[]): SettingDefinition[] {
	const out: SettingDefinition[] = [];
	for (const item of items) {
		if ("type" in item) {
			if (item.items) out.push(...flatten(item.items));
			continue;
		}
		out.push(item);
	}
	return out;
}

function groupHeadings(items: SettingDefinitionItem[]): string[] {
	return items.flatMap((item) => "type" in item && item.type === "group" && "heading" in item && typeof item.heading === "string" ? [item.heading] : []);
}

function groupItems(items: SettingDefinitionItem[], heading: string): string[] {
	for (const item of items) {
		if ("type" in item && item.type === "group" && item.heading === heading) {
			return (item.items ?? []).map((i) => ("name" in i ? String(i.name) : ""));
		}
	}
	return [];
}

function pageNames(items: SettingDefinitionItem[]): string[] {
	return items.flatMap((item) => "type" in item && item.type === "page" ? [item.name] : []);
}

interface Fixture {
	tab: VaultSyncSettingTab;
	settings: VaultSyncSettings;
	reasons: string[];
	calls: string[];
}

function makeFixture(overrides: Partial<VaultSyncSettings> = {}, withDriveHost = true, wizardCalls?: string[]): Fixture {
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const reasons: string[] = [];
	const calls: string[] = [];
	const host: VaultSyncSettingsHost = {
		settings,
		serverAuthMode: "claim",
		serverSupportsAttachments: true,
		serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: async (mutator, reason) => {
			mutator(settings);
			reasons.push(reason ?? "");
		},
		refreshServerCapabilities: async () => {},
		refreshUpdateManifest: async () => {},
		refreshAttachmentSyncRuntime: async () => {},
		getSettingsStatusSummary: () => ({ state: "connected", label: "Connected" }),
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
		...(wizardCalls ? { openDriveWizard: () => { wizardCalls.push("wizard"); } } : {}),
		...(withDriveHost ? {
			signInToDrive: async () => { calls.push("signIn"); },
			signOutOfDrive: async () => { calls.push("signOut"); },
		} : {}),
	};
	const plugin = Object.create(Plugin.prototype) as Plugin;
	return { tab: new VaultSyncSettingTab(new App(), plugin, host), settings, reasons, calls };
}

function advancedItems(items: SettingDefinitionItem[]): SettingDefinitionItem[] {
	for (const item of items) {
		if ("type" in item && item.type === "page" && item.name === "Advanced") return item.items ?? [];
	}
	return [];
}

s.section("Test 1: helpers");
{
	s.check(currentCarrier({}) === "cloudflare" && currentCarrier({ carrier: "cloudflare" }) === "cloudflare", "no setting means Cloudflare");
	s.check(currentCarrier({ carrier: "drive" }) === "drive" && isDriveCarrier({ carrier: "drive" }), "drive when chosen");
	s.check(currentCarrier({ carrier: "bogus" as never }) === "cloudflare", "an unknown value falls back to Cloudflare");
	s.check(isCarrierKind("drive") && isCarrierKind("cloudflare") && !isCarrierKind("s3"), "carrier names validated");
	s.check(!isDriveSignedIn({}) && !isDriveSignedIn({ driveClientId: "a", driveClientSecret: "b" }) && !isDriveSignedIn({ driveClientId: " ", driveClientSecret: "b", driveRefreshToken: "r" }), "signed in needs client id, secret and refresh token");
	s.check(isDriveSignedIn({ driveClientId: "a", driveClientSecret: "b", driveRefreshToken: "r" }), "complete settings count as signed in");
	s.check(driveFolderLabel("abc") === "YAOS abc", "folder label");
	const id = newDriveDeviceId(() => "ab-_cd_-xy");
	s.check(/^[A-Za-z0-9]+$/.test(id) && id.length === 10, "device ids are letters and digits only");
}

s.section("Test 2: saved settings are untouched unless the carrier is chosen");
{
	const keys = Object.keys(DEFAULT_SETTINGS);
	s.check(!keys.some((k) => k === "carrier" || k.startsWith("drive")), "no carrier key in the defaults");
	const { settings } = readVaultSyncSettings({ host: "https://x.example", token: "t", vaultId: "v" });
	s.check(!("carrier" in settings) && !Object.keys(settings).some((k) => k.startsWith("drive")), "loading old data adds no carrier keys");
	let saved: Record<string, unknown> | null = null;
	const store = new SettingsStore<Partial<VaultSyncSettings>>({
		loadData: () => Promise.resolve({ host: "h", token: "t" }),
		saveData: (d: unknown) => { saved = d as Record<string, unknown>; return Promise.resolve(); },
	});
	const loaded = await store.load();
	await store.save(store.withSettings(loaded.persistedState, loaded.settings));
	s.check(saved !== null && !Object.keys(saved).some((k) => k === "carrier" || k.startsWith("drive")), "saving an old user's data writes no carrier keys");
	const kept = readVaultSyncSettings({ carrier: "drive", driveClientId: "i", driveRefreshToken: "r", driveEncryptionPassphrase: "pp" }).settings;
	s.check(kept.driveEncryptionPassphrase === "pp", "a saved passphrase survives loading");
	s.check(kept.carrier === "drive" && kept.driveClientId === "i" && kept.driveRefreshToken === "r", "chosen values survive loading");
}

s.section("Test 3: default (Cloudflare) screens are the same as before, plus one row");
{
	const unconfigured = makeFixture();
	const items = unconfigured.tab.getSettingDefinitions();
	// The P2P (experimental) group (Phase 0 spike, plan §8) is appended last
	// in every layout; the rest of the inventory is unchanged.
	s.check(groupHeadings(items).join() === "Setup,This device,What syncs,Attachments,Collaboration,P2P (experimental)", `unconfigured groups (${groupHeadings(items).join()})`);
	s.check(pageNames(items).join() === "Manual connection,Advanced", "pages unchanged");
	const adv = advancedItems(items);
	const advNames = adv.map((i) => "name" in i ? i.name : "");
	s.check(advNames.join("|") === ["Vault ID", "Deployment repository URL", "Deployment default branch", "Edits from other apps", "Frontmatter safety guard", "Debug mode", "Status icon in the note header", "Detailed status text", "Reload required"].join("|"), `Advanced is as before when no server is set up yet, plus the two status display switches (${advNames.join("|")})`);
	s.check(groupItems(items, "Setup").join("|") === "Setup required|Sync carrier (experimental)|Deploy your server", `Setup: the carrier choice comes right above "Deploy your server" (${groupItems(items, "Setup").join("|")})`);
	const setupRow = flatten(items).find((d) => d.name === "Sync carrier (experimental)");
	s.check(setupRow?.control?.key === "carrier" && flatten(items).filter((d) => d.name === "Sync carrier (experimental)").length === 1, "one carrier dropdown, bound to the carrier setting");
	const configured = makeFixture({ host: "https://sync.example", token: "tok", vaultId: "vid" });
	const cItems = configured.tab.getSettingDefinitions();
	s.check(groupHeadings(cItems).join() === "Sync status,Updates,This device,What syncs,Attachments,Collaboration,P2P (experimental)", `configured groups (${groupHeadings(cItems).join()})`);
	s.check(advancedItems(cItems).map((i) => ("name" in i ? i.name : "")).join("|") === ["Sync carrier (experimental)", "Vault ID", "Deployment repository URL", "Deployment default branch", "Edits from other apps", "Frontmatter safety guard", "Debug mode", "Sync speed (Cloudflare)", "Group edits for (seconds)", "Status icon in the note header", "Detailed status text", "Reload required"].join("|"), "a configured Cloudflare user finds the carrier row first in Advanced, then the two sync-speed rows and the two status display switches just above the reload note");
	s.check(!groupItems(cItems, "Sync status").includes("Sync carrier (experimental)"), "and the Sync status group is untouched");
	const defs = flatten(cItems);
	s.check(!defs.some((d) => d.name === "Sign in with Google" || d.name === "Google client ID" || d.name === "Encryption passphrase"), "no Drive rows for Cloudflare users");
	s.check(defs.some((d) => d.control?.key === "host") && defs.some((d) => d.control?.key === "token"), "server rows still present");
	s.check(configured.tab.getControlValue("carrier") === "cloudflare", "dropdown shows Cloudflare");
}

s.section("Test 4: choosing the carrier");
{
	const f = makeFixture({ host: "https://sync.example", token: "tok" });
	await f.tab.setControlValue("carrier", "drive");
	s.check(f.settings.carrier === "drive" && f.reasons.at(-1) === "settings:carrier", "choice saved");
	s.check(f.settings.host === "https://sync.example" && f.settings.token === "tok", "the Cloudflare settings are kept, so switching back is easy");
	await f.tab.setControlValue("carrier", "cloudflare");
	s.check(f.settings.carrier === "cloudflare", "can switch back");
	let rejected = false;
	try { await f.tab.setControlValue("carrier", "ftp"); } catch { rejected = true; }
	s.check(rejected && f.settings.carrier === "cloudflare", "an unknown carrier is rejected");
	let wrongType = false;
	try { await f.tab.setControlValue("carrier", 3); } catch { wrongType = true; }
	s.check(wrongType, "a non-string is rejected");
	await f.tab.setControlValue("driveClientId", "  id-1 ");
	await f.tab.setControlValue("driveClientSecret", " sec ");
	s.check(f.settings.driveClientId === "id-1" && f.settings.driveClientSecret === "sec", "client details are trimmed and saved");
	s.check(f.tab.getControlValue("driveClientId") === "id-1" && f.tab.getControlValue("driveClientSecret") === "sec", "and read back");
	s.check(makeFixture().tab.getControlValue("driveClientId") === "", "empty by default");
	s.check(f.tab.getControlValue("driveEncryptionPassphrase") === "" && f.settings.driveEncryptionPassphrase === undefined, "no encryption passphrase by default");
	await f.tab.setControlValue("driveEncryptionPassphrase", "  my pass phrase ");
	s.check(f.settings.driveEncryptionPassphrase === "  my pass phrase ", "the passphrase is saved exactly as typed (spaces can be part of it)");
	s.check(f.tab.getControlValue("driveEncryptionPassphrase") === "  my pass phrase ", "and read back");
	let badPass = false;
	try { await f.tab.setControlValue("driveEncryptionPassphrase", 5); } catch { badPass = true; }
	s.check(badPass, "a non-string passphrase is rejected");
}

s.section("Test 5: Drive screens");
{
	const f = makeFixture({ carrier: "drive", host: "https://old.example", token: "old", vaultId: "vault-1" });
	const items = f.tab.getSettingDefinitions();
	const heads = groupHeadings(items);
	s.check(heads[0] === "Google Drive carrier", `Drive group comes first (${heads.join()})`);
	for (const gone of ["Setup", "Sync status", "Updates", "Collaboration"]) {
		s.check(!heads.includes(gone), `no "${gone}" group with the Drive carrier`);
	}
	s.check(!heads.includes("This device") && heads.includes("What syncs"), "the device-name group is gone (it only feeds live cursors), the other generic groups remain");
	s.check(heads.includes("Attachments"), "the Attachments group stays (attachments live on Drive)");
	const storage = flatten(items).find((d) => d.name === "Attachment storage");
	s.check(String(storage?.desc) === 'Stored in your Google Drive (folder "YAOS vault-1 blobs"). Snapshots are kept there too.', "its storage line names the Drive folder");
	s.check(!flatten(items).some((d) => String(d.desc ?? "").includes("Cloudflare")), "no Cloudflare wording in the Attachments group");
	s.check(!pageNames(items).includes("Manual connection") && pageNames(items).includes("Advanced"), "server page hidden, Advanced kept");
	const adv = advancedItems(items).map((i) => "name" in i ? i.name : "");
	s.check(!adv.includes("Sync carrier (experimental)") && !adv.includes("Deployment repository URL") && !adv.includes("Deployment default branch") && !adv.includes("Vault ID"), `Advanced drops the server-only rows, the carrier row and the duplicate Vault ID (${adv.join("|")})`);
	const driveRows = groupItems(items, "Google Drive carrier");
	s.check(driveRows[0] === "Status" && driveRows[1] === "Sync carrier (experimental)" && driveRows[2] === "Set up Google Drive", `the carrier choice and the wizard button are at the top of the Drive group (${driveRows.slice(0, 4).join("|")})`);
	s.check(flatten(items).filter((d) => d.name === "Sync carrier (experimental)").length === 1, "and appears only once");
	const driveNames = flatten(items).map((d) => String(d.name));
	for (const gone of ["Deploy your server", "Setup required", "Server", "Server URL", "Sync token", "Pair another device", "Back up connection details", "Refresh attachment capability", "Set up attachment storage", "Deployment repository URL", "Deployment default branch", "Check for updates"]) {
		s.check(!driveNames.includes(gone), `Drive mode hides the Cloudflare row "${gone}"`);
	}
	const reloadRow = flatten(advancedItems(items)).find((d) => d.name === "Reload required");
	s.check(!!reloadRow && !/server URL|sync token/i.test(String(reloadRow.desc)), "the reload hint no longer talks about the server URL or sync token");
	const wording = flatten(items).filter((d) => d.name !== "Sync carrier (experimental)" && /Cloudflare|\bserver\b|\bWorker\b|\bR2\b|sync token/i.test(`${String(d.name)} ${String(d.desc ?? "")}`)).map((d) => String(d.name));
	s.check(wording.length === 0, `no Cloudflare/server wording left on the Drive screen (${wording.join("|") || "none"})`);
	const defs = flatten(items);
	const byName = (n: string) => defs.find((d) => d.name === n);
	s.check(byName("Folder on Drive") === undefined, "no separate folder row");
	s.check(String(byName("Vault ID")?.desc).includes('"YAOS vault-1"'), "the Vault ID row names the folder instead");
	s.check(String(byName("Status")?.desc).includes("Not signed in"), "status says not signed in");
	const signIn = byName("Sign in with Google");
	s.check(signIn !== undefined && "action" in signIn, "sign-in action present");
	const signOut = byName("Sign out");
	const visible = signOut && "visible" in signOut ? signOut.visible : undefined;
	s.check(typeof visible === "function" && visible() === false, "Sign out hidden while signed out");
	press(signIn);
	await Promise.resolve();
	await Promise.resolve();
	s.check(f.calls.join() === "signIn", "the sign-in row calls the host");

	f.settings.driveClientId = "i";
	f.settings.driveClientSecret = "x";
	f.settings.driveRefreshToken = "r";
	const items2 = f.tab.getSettingDefinitions();
	const defs2 = flatten(items2);
	const out2 = defs2.find((d) => d.name === "Sign out");
	const vis2 = out2 && "visible" in out2 ? out2.visible : undefined;
	s.check(typeof vis2 === "function" && vis2() === true, "Sign out appears once signed in");
	s.check(String(defs2.find((d) => d.name === "Status")?.desc) === "Connected", "status shows the sync status when signed in");
	s.check(defs2.some((d) => d.name === "Signed in to Google"), "sign-in row shows the signed-in state");
	press(out2);
	await Promise.resolve();
	await Promise.resolve();
	s.check(f.calls.join() === "signIn,signOut", "sign out calls the host");
	s.check(defs2.some((d) => d.control?.key === "vaultId"), "vault ID editable on the Drive screen");
	s.check(defs2.some((d) => d.control?.key === "driveClientId") && defs2.some((d) => d.control?.key === "driveClientSecret"), "client fields present");
	const pass = defs2.find((d) => d.control?.key === "driveEncryptionPassphrase");
	s.check(pass?.name === "Encryption passphrase" && String(pass.desc).includes("before the first sync") && String(pass.desc).includes("cannot be recovered"), "the passphrase row warns about the one-time choice and about loss");
}

s.section("Test 6: a host without Drive support does not break the screen");
{
	const f = makeFixture({ carrier: "drive" }, false);
	const items = f.tab.getSettingDefinitions();
	const signIn = flatten(items).find((d) => d.name === "Sign in with Google");
	let threw = false;
	try {
		press(signIn);
		await Promise.resolve();
	} catch { threw = true; }
	s.check(!threw && f.calls.length === 0, "clicking does nothing and does not throw");
}

s.section("Test 7: the transport factory");
{
	const requests: DriveHttpRequest[] = [];
	const http: DriveHttp = (req) => {
		requests.push(req);
		return Promise.reject(new Error("no network in this test"));
	};
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, carrier: "drive", driveClientId: "i", driveClientSecret: "x", driveRefreshToken: "r", driveDeviceId: "dev1" };
	const logs: string[] = [];
	const factory = createDriveTransportFactory({ getSettings: () => settings, http, log: (m) => logs.push(m), onSignInLost: () => undefined });
	const { Doc } = await import("yjs");
	const doc = new Doc();
	const persistenceOrigin = {};
	const transport = factory({ doc, vaultId: "vid", isLocalStoreOrigin: (o) => o === persistenceOrigin });
	s.check(transport instanceof DriveTransport && requests.length === 0, "builds a Drive transport and makes no request until connect");
	doc.transact(() => { doc.getText("t").insert(0, "from disk"); }, persistenceOrigin);
	s.check((transport as DriveTransport).pendingParts === 0, "updates replayed from the local database are not queued for upload");
	doc.getText("t").insert(0, "typed ");
	s.check((transport as DriveTransport).pendingParts === 1, "real edits are queued");
	transport.destroy();
}

s.section("Test 8: the setup wizard hooks");
{
	const calls: string[] = [];
	const f = makeFixture({ carrier: "drive" }, true, calls);
	const row = flatten(f.tab.getSettingDefinitions()).find((d) => d.name === "Set up Google Drive");
	const rowVisible = row && "visible" in row ? row.visible : undefined;
	s.check(!!row && typeof rowVisible === "function" && rowVisible() === true, "the wizard row is shown when the host can open the wizard");
	press(row);
	s.check(calls.join() === "wizard", "pressing it opens the wizard");
	const noHost = makeFixture({ carrier: "drive" }, true);
	const hidden = flatten(noHost.tab.getSettingDefinitions()).find((d) => d.name === "Set up Google Drive");
	const hiddenVisible = hidden && "visible" in hidden ? hidden.visible : undefined;
	s.check(typeof hiddenVisible === "function" && hiddenVisible() === false, "without a wizard host the row stays hidden");
	for (const settings of [{}, { host: "https://sync.example", token: "tok" }] as Partial<VaultSyncSettings>[]) {
		const cf = makeFixture(settings, true, calls);
		const rows = flatten(cf.tab.getSettingDefinitions()).filter((d) => d.name === "Set up Google Drive");
		s.check(rows.length === 0, "Cloudflare screens never contain the wizard row");
	}

	// Choosing Drive opens the wizard only when nobody is signed in yet.
	const before = calls.length;
	const fresh = makeFixture({}, true, calls);
	await fresh.tab.setControlValue("carrier", "drive");
	s.check(calls.length === before + 1, "choosing Drive while signed out opens the wizard");
	const signedIn = makeFixture({ driveClientId: "i", driveClientSecret: "x", driveRefreshToken: "r" }, true, calls);
	await signedIn.tab.setControlValue("carrier", "drive");
	s.check(calls.length === before + 1, "choosing Drive while signed in does not");
	const back = makeFixture({ carrier: "drive" }, true, calls);
	await back.tab.setControlValue("carrier", "cloudflare");
	s.check(calls.length === before + 1, "choosing Cloudflare never opens it");
	const noWizardHost = makeFixture({}, true);
	await noWizardHost.tab.setControlValue("carrier", "drive");
	s.check(noWizardHost.settings.carrier === "drive", "a host without the wizard still just saves the choice");
	const status = flatten(f.tab.getSettingDefinitions()).find((d) => d.name === "Status");
	s.check(/Not signed in/.test(String(status?.desc ?? "")) && /Set up Google Drive/.test(String(status?.desc ?? "")), "the Status row points to the wizard");
}

s.section("Test 9: the easy sign-in on the settings screen");
{
	const TOKEN = "1//0gHostedRefreshTokenForTests-0123456789";
	const isVisible = (d: SettingDefinition | undefined): boolean => {
		if (!d) return false;
		const v = "visible" in d ? d.visible : undefined;
		return typeof v === "function" ? v() : v !== false;
	};
	const names = (f: Fixture): string[] => flatten(f.tab.getSettingDefinitions()).filter(isVisible).map((d) => d.name ?? "");

	const classic = names(makeFixture({ carrier: "drive", driveClientId: "i", driveClientSecret: "x", driveRefreshToken: "r" }));
	for (const row of ["Google client ID", "Google client secret", "Signed in to Google", "Sign out", "Encryption passphrase"]) {
		s.check(classic.includes(row), `normal sign-in: "${row}" is still shown`);
	}
	s.check(!classic.includes("Sign-in code (easy sign-in)"), "normal sign-in: no easy sign-in row");
	const classicOut = names(makeFixture({ carrier: "drive" }));
	s.check(classicOut.includes("Sign in with Google") && classicOut.includes("Google client ID"), "signed out, normal: the old rows are all there");

	const easy = names(makeFixture({ carrier: "drive", driveAuthMode: "hosted", driveRefreshToken: TOKEN }, true, []));
	s.check(!easy.includes("Google client ID") && !easy.includes("Google client secret"), "easy sign-in: no client rows");
	s.check(!easy.includes("Sign in with Google") && !easy.includes("Signed in to Google"), "easy sign-in: no Google code sign-in button");
	s.check(easy.includes("Sign-in code (easy sign-in)") && easy.includes("Sign out") && easy.includes("Encryption passphrase") && easy.includes("Set up Google Drive"), "easy sign-in: its own code row, Sign out, passphrase and the wizard stay");
	const stat = flatten(makeFixture({ carrier: "drive", driveAuthMode: "hosted", driveRefreshToken: TOKEN }, true, []).tab.getSettingDefinitions()).find((d) => d.name === "Status");
	s.check(/Signed in with the easy sign-in/.test(String(stat?.desc ?? "")), "the status says which sign-in is used");

	const f = makeFixture({ carrier: "drive", driveAuthMode: "hosted", driveRefreshToken: TOKEN });
	s.check(f.tab.getControlValue("driveHostedToken") === TOKEN, "the code row shows the saved code");
	await f.tab.setControlValue("driveHostedToken", `  "${TOKEN}-2" `);
	s.check(f.settings.driveRefreshToken === `${TOKEN}-2` && f.reasons.at(-1) === "settings:drive-hosted-token", "a new code is cleaned and saved");
	const reasonsBefore = f.reasons.length;
	await f.tab.setControlValue("driveHostedToken", "nope");
	s.check(f.settings.driveRefreshToken === `${TOKEN}-2` && f.reasons.length === reasonsBefore, "something that is not a code is refused and nothing is saved");
	await f.tab.setControlValue("driveHostedToken", "");
	s.check(f.settings.driveRefreshToken === "", "clearing it signs out");
	let wrong = false;
	try { await f.tab.setControlValue("driveHostedToken", 5); } catch { wrong = true; }
	s.check(wrong, "a non-string is rejected");

	const cloudflare = names(makeFixture({ host: "https://sync.example", token: "tok", vaultId: "vid" }));
	s.check(!cloudflare.includes("Sign-in code (easy sign-in)"), "Cloudflare users never see the easy sign-in row");
}

s.section("Test 10: the beginner view of the Drive screen");
{
	const TOKEN = "1//0gHostedRefreshTokenForTests-0123456789";
	const visibleNames = (defs: SettingDefinition[]): string[] => defs.filter((d) => {
		const v = "visible" in d ? d.visible : undefined;
		return typeof v === "function" ? v() : v !== false;
	}).map((d) => d.name ?? "");
	const mainRows = (f: Fixture): string[] => visibleNames(f.tab.getSettingDefinitions().flatMap((item) => ("type" in item && item.type === "group" ? item.items ?? [] : []).flatMap((i) => ("type" in i ? [] : [i]))));
	const manualPage = (f: Fixture) => f.tab.getSettingDefinitions().find((item) => "type" in item && item.type === "page" && item.name === "Manual setup (advanced)");
	const manualRows = (f: Fixture): string[] => {
		const page = manualPage(f);
		return page && "items" in page ? visibleNames(flatten(page.items ?? [])) : [];
	};

	const signedOut = makeFixture({ carrier: "drive" }, true, []);
	const rows = mainRows(signedOut);
	for (const gone of ["Folder on Drive", "Vault ID", "Google client ID", "Google client secret", "Encryption passphrase", "Sign in with Google", "Signed in to Google", "Sign-in code (easy sign-in)", "Device name"]) {
		s.check(!rows.includes(gone), `main screen: "${gone}" is not shown`);
	}
	s.check(groupItems(signedOut.tab.getSettingDefinitions(), "Google Drive carrier").join("|") === "Status|Sync carrier (experimental)|Set up Google Drive|Sign out", "the Drive group holds only status, the way of syncing, the guide and sign out");
	s.check(visibleNames(flatten(signedOut.tab.getSettingDefinitions())).filter((n) => n === "Sign out").length === 0, "Sign out is hidden while signed out");
	s.check(rows.includes("Status") && rows.includes("Sync carrier (experimental)") && rows.includes("Set up Google Drive"), "status, the carrier dropdown and the guide stay");
	const page = manualPage(signedOut);
	s.check(!!page && "status" in page && typeof page.status === "function" && page.status() === "warning", "the manual page shows a warning mark while signed out");
	s.check(manualRows(signedOut).join("|") === "Vault ID|Google client ID|Google client secret|Encryption passphrase|Sign in with Google", `manual page, signed out (${manualRows(signedOut).join("|")})`);
	const order = signedOut.tab.getSettingDefinitions().filter((i) => "type" in i && i.type === "page").map((i) => ("name" in i ? i.name : ""));
	s.check(order.join() === "Manual setup (advanced),Advanced", `the manual page comes right before Advanced (${order.join()})`);
	s.check(/Manual setup \(advanced\)/.test(String(flatten(signedOut.tab.getSettingDefinitions()).find((d) => d.name === "Status")?.desc)), "the status text points to it");

	const own = makeFixture({ carrier: "drive", driveClientId: "i", driveClientSecret: "x", driveRefreshToken: "r" }, true, []);
	s.check(manualRows(own).join("|") === "Vault ID|Google client ID|Google client secret|Encryption passphrase|Signed in to Google", "manual page, own client signed in");
	s.check(mainRows(own).includes("Sign out"), "Sign out is shown on the main screen once signed in");
	const pageOwn = manualPage(own);
	s.check(!!pageOwn && "status" in pageOwn && typeof pageOwn.status === "function" && pageOwn.status() === null, "no warning mark when signed in");

	const easy = makeFixture({ carrier: "drive", driveAuthMode: "hosted", driveRefreshToken: TOKEN }, true, []);
	s.check(manualRows(easy).join("|") === "Vault ID|Sign-in code (easy sign-in)|Encryption passphrase", `manual page, easy sign-in (${manualRows(easy).join("|")})`);
	s.check(!mainRows(easy).includes("Sign-in code (easy sign-in)"), "the easy sign-in code is not on the main screen");

	// Every control is still reachable, so nothing was lost.
	const keys = flatten(signedOut.tab.getSettingDefinitions()).map((d) => d.control?.key);
	for (const key of ["vaultId", "driveClientId", "driveClientSecret", "driveEncryptionPassphrase", "excludePatterns", "maxFileSizeKB", "enableAttachmentSync"]) {
		s.check(keys.includes(key), `the control "${key}" is still reachable`);
	}
	s.check(keys.filter((k) => k === "vaultId").length === 1, "and the vault ID control exists exactly once");
	const adv = advancedItems(signedOut.tab.getSettingDefinitions());
	const advPage = signedOut.tab.getSettingDefinitions().find((i) => "type" in i && i.type === "page" && i.name === "Advanced");
	s.check(adv.length === 6 && !!advPage && "desc" in advPage && !/deployment/i.test(String(advPage.desc)), "Advanced keeps its four rows (plus the two status display switches) and no longer talks about deployment");

	// Cloudflare screens are exactly as before.
	for (const settings of [{}, { host: "https://sync.example", token: "tok", vaultId: "vid" }] as Partial<VaultSyncSettings>[]) {
		const cf = makeFixture(settings, true, []);
		const defs = cf.tab.getSettingDefinitions();
		s.check(!defs.some((i) => "type" in i && i.type === "page" && i.name === "Manual setup (advanced)"), "Cloudflare: no manual setup page");
		s.check(groupHeadings(defs).includes("This device"), "Cloudflare: the device-name group is still there");
		const cfAdvanced = advancedItems(defs).map((i) => ("name" in i ? i.name : ""));
		s.check(cfAdvanced.includes("Vault ID") && cfAdvanced.includes("Deployment repository URL"), "Cloudflare: Advanced still has Vault ID and the deployment rows");
		const cfAdvancedPage = defs.find((i) => "type" in i && i.type === "page" && i.name === "Advanced");
		s.check(!!cfAdvancedPage && "desc" in cfAdvancedPage && String(cfAdvancedPage.desc).includes("deployment metadata"), "Cloudflare: Advanced keeps its original description");
	}
}

s.section("Test 11: command palette names");
{
	const names = (host: Partial<CommandsRuntimeHost>): Record<string, string> => {
		const out: Record<string, string> = {};
		const calls: string[] = [];
		const stub = {} as CommandsRuntimeHost;
		registerCommands(
			{ addCommand: (c) => { out[c.id] = c.name; calls.push(c.id); return c; } },
			Object.assign(stub, host),
		);
		out["#count"] = String(calls.length);
		return out;
	};
	const cf = names({});
	const cfExplicit = names({ isDriveCarrier: () => false });
	s.check(JSON.stringify(cf) === JSON.stringify(cfExplicit), "Cloudflare: an explicit 'not Drive' answer changes nothing");
	s.check(cf.reconnect === "Reconnect to sync server", "Cloudflare: reconnect keeps its name");
	s.check(cf["clear-local-server-receipt-state"] === "Clear local server-receipt state", "Cloudflare: receipt command keeps its name");
	s.check(cf["reset-cache"] === "Reset local cache (re-sync from server)", "Cloudflare: reset cache keeps its name");
	const drive = names({ isDriveCarrier: () => true });
	s.check(drive["#count"] === cf["#count"] && cf["#count"] === "10", "Drive: the same ten commands exist");
	s.check(drive.reconnect === "Retry syncing with Google Drive", "Drive: reconnect is renamed");
	s.check(drive["clear-local-server-receipt-state"] === "Clear local save-confirmation state", "Drive: receipt command is renamed");
	s.check(drive["reset-cache"] === "Reset local cache (re-sync from Google Drive)", "Drive: reset cache is renamed");
	const changed = Object.keys(cf).filter((k) => cf[k] !== drive[k]).sort();
	s.check(changed.join() === "clear-local-server-receipt-state,reconnect,reset-cache", `Drive: only those three change (${changed.join()})`);
	s.check(!Object.entries(drive).some(([k, v]) => k !== "#count" && /server/i.test(v)), "Drive: no command name mentions a server");
}

/** Click a setting row that has an action. */
function press(def: SettingDefinition | undefined): void {
	if (def && "action" in def && typeof def.action === "function") def.action({} as HTMLElement, 0);
}

await s.done();
