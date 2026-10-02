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

function pageNames(items: SettingDefinitionItem[]): string[] {
	return items.flatMap((item) => "type" in item && item.type === "page" ? [item.name] : []);
}

interface Fixture {
	tab: VaultSyncSettingTab;
	settings: VaultSyncSettings;
	reasons: string[];
	calls: string[];
}

function makeFixture(overrides: Partial<VaultSyncSettings> = {}, withDriveHost = true): Fixture {
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
	const kept = readVaultSyncSettings({ carrier: "drive", driveClientId: "i", driveRefreshToken: "r" }).settings;
	s.check(kept.carrier === "drive" && kept.driveClientId === "i" && kept.driveRefreshToken === "r", "chosen values survive loading");
}

s.section("Test 3: default (Cloudflare) screens are the same as before, plus one row");
{
	const unconfigured = makeFixture();
	const items = unconfigured.tab.getSettingDefinitions();
	s.check(groupHeadings(items).join() === "Setup,This device,What syncs,Attachments,Collaboration", `unconfigured groups (${groupHeadings(items).join()})`);
	s.check(pageNames(items).join() === "Manual connection,Advanced", "pages unchanged");
	const adv = advancedItems(items);
	const advNames = adv.map((i) => "name" in i ? i.name : "");
	s.check(advNames.join("|") === ["Sync carrier (experimental)", "Vault ID", "Deployment repository URL", "Deployment default branch", "Edits from other apps", "Frontmatter safety guard", "Debug mode", "Reload required"].join("|"), `Advanced = old rows + carrier row first (${advNames.join("|")})`);
	const configured = makeFixture({ host: "https://sync.example", token: "tok", vaultId: "vid" });
	const cItems = configured.tab.getSettingDefinitions();
	s.check(groupHeadings(cItems).join() === "Sync status,Updates,This device,What syncs,Attachments,Collaboration", `configured groups (${groupHeadings(cItems).join()})`);
	const defs = flatten(cItems);
	s.check(!defs.some((d) => d.name === "Sign in with Google" || d.name === "Google client ID"), "no Drive rows for Cloudflare users");
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
	s.check(heads.includes("This device") && heads.includes("What syncs"), "generic groups remain");
	s.check(heads.includes("Attachments"), "the Attachments group stays (attachments live on Drive)");
	const storage = flatten(items).find((d) => d.name === "Attachment storage");
	s.check(String(storage?.desc) === 'Stored in your Google Drive (folder "YAOS vault-1 blobs"). Snapshots are kept there too.', "its storage line names the Drive folder");
	s.check(!flatten(items).some((d) => String(d.desc ?? "").includes("Cloudflare")), "no Cloudflare wording in the Attachments group");
	s.check(!pageNames(items).includes("Manual connection") && pageNames(items).includes("Advanced"), "server page hidden, Advanced kept");
	const adv = advancedItems(items).map((i) => "name" in i ? i.name : "");
	s.check(adv[0] === "Sync carrier (experimental)" && !adv.includes("Deployment repository URL") && !adv.includes("Deployment default branch") && adv.includes("Vault ID"), `Advanced keeps the carrier row and drops server-only rows (${adv.join("|")})`);
	const defs = flatten(items);
	const byName = (n: string) => defs.find((d) => d.name === n);
	s.check(byName("Folder on Drive") !== undefined && "desc" in (byName("Folder on Drive") ?? {}), "folder name shown");
	s.check(String(byName("Folder on Drive")?.desc) === "YAOS vault-1", "folder is YAOS <vault id>");
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

/** Click a setting row that has an action. */
function press(def: SettingDefinition | undefined): void {
	if (def && "action" in def && typeof def.action === "function") def.action({} as HTMLElement, 0);
}

await s.done();
