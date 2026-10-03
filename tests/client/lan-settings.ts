/**
 * Local network carrier — settings, setup code, the settings screen, and the guarantee that
 * nothing changes for anyone who does not choose it.
 */
import { App, Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { currentCarrier, isCarrierKind, isDriveCarrier, isLanCarrier, isP2pCarrier } from "../../src/drive-carrier/carrierSettings";
import {
	applyLanSetupCode,
	ensureLanIdentity,
	explainBadSetupCode,
	isLanDiscoveryOn,
	lanDiscoveryPortOf,
	lanManualPeerList,
	lanPortOf,
	lanSetupCodeOf,
	makeLanSetupCode,
	parseLanSetupCode,
	readLanSetting,
	validateManualPeers,
	writeLanSetting,
	type LanCarrierSettings,
} from "../../src/lan-carrier/lanSettings";
import { describeLanStatus, type LanSettingsHost } from "../../src/lan-carrier/lanSettingsRows";
import type { LanStatusView } from "../../src/lan-carrier/lanCarrierRuntime";
import { generateLanKey } from "../../src/lan-carrier/lanAuth";
import { DEFAULT_SETTINGS, readVaultSyncSettings, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { VaultSyncSettingTab, type VaultSyncSettingsHost } from "../../src/settings/settingsTab";
import { registerCommands, type CommandsRuntimeHost } from "../../src/commands";
import { isExcluded } from "../../src/sync/exclude";
import { suite } from "../harness.ts";

const s = suite("lan-settings");

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
const headings = (items: SettingDefinitionItem[]): string[] =>
	items.flatMap((i) => ("type" in i && i.type === "group" && typeof i.heading === "string" ? [i.heading] : []));
const pages = (items: SettingDefinitionItem[]): string[] =>
	items.flatMap((i) => ("type" in i && i.type === "page" ? [i.name] : []));
const names = (items: SettingDefinitionItem[]): string[] => flatten(items).map((d) => d.name);

const emptyStatus: LanStatusView = { running: false, listening: false, port: null, error: null, discoveryRunning: false, fingerprint: "", linked: [], seen: [], refusals: [] };

interface Fixture { tab: VaultSyncSettingTab; settings: VaultSyncSettings; reasons: string[]; calls: string[]; status: { value: LanStatusView } }

function makeFixture(overrides: Partial<VaultSyncSettings> = {}, withLan = true): Fixture {
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const reasons: string[] = [];
	const calls: string[] = [];
	const status = { value: emptyStatus };
	const lan: LanSettingsHost = {
		available: true,
		prepare: () => { calls.push("prepare"); return Promise.resolve(); },
		status: () => status.value,
		copySetupCode: () => { calls.push("copy"); },
		regenerateKey: () => { calls.push("regenerate"); return Promise.resolve(); },
		forgetDevice: (id) => { calls.push(`forget:${id}`); return Promise.resolve(); },
		applyManualPeers: () => { calls.push("peers"); },
	};
	const host: VaultSyncSettingsHost = {
		settings,
		serverAuthMode: "claim",
		serverSupportsAttachments: true,
		serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: (mutator, reason) => { mutator(settings); reasons.push(reason ?? ""); return Promise.resolve(); },
		refreshServerCapabilities: () => Promise.resolve(),
		refreshUpdateManifest: () => Promise.resolve(),
		refreshAttachmentSyncRuntime: () => Promise.resolve(),
		getSettingsStatusSummary: () => ({ state: "connected", label: "Connected" }),
		getUpdateState: () => ({
			serverVersion: null, latestServerVersion: null, serverUpdateAvailable: false, pluginVersion: "2.0.0", latestPluginVersion: null,
			pluginUpdateRecommended: false, updateRepoUrl: null, updateActionUrl: null, updateBootstrapUrl: null, legacyServerDetected: false, pluginCompatibilityWarning: null,
		}),
		buildSetupDeepLink: () => null,
		buildMobileSetupUrl: () => null,
		buildRecoveryKitText: () => null,
		...(withLan ? { lan } : {}),
	};
	const plugin = Object.create(Plugin.prototype) as Plugin;
	return { tab: new VaultSyncSettingTab(new App(), plugin, host), settings, reasons, calls, status };
}

async function throws(run: () => Promise<unknown> | unknown): Promise<boolean> {
	try { await run(); return false; } catch { return true; }
}

s.section("1: the carrier names");
{
	s.check(currentCarrier({ carrier: "lan" }) === "lan" && isLanCarrier({ carrier: "lan" }), "lan when chosen");
	s.check(!isLanCarrier({}) && !isLanCarrier({ carrier: "drive" }) && !isLanCarrier({ carrier: "p2p" }) && !isLanCarrier({ carrier: "cloudflare" }) && !isLanCarrier({ carrier: "bogus" as never }), "lan never means anything else");
	s.check(!isDriveCarrier({ carrier: "lan" }) && !isP2pCarrier({ carrier: "lan" }), "and the other carriers never mean lan");
	s.check(isCarrierKind("lan") && !isCarrierKind("lan2"), "validated");
	s.check(currentCarrier({}) === "cloudflare", "nothing set is still Cloudflare");
}

s.section("2: saved settings are untouched unless the carrier is chosen");
{
	s.check(!Object.keys(DEFAULT_SETTINGS).some((k) => k.startsWith("lan")), "no lan key in the defaults");
	const { settings } = readVaultSyncSettings({ host: "https://x.example", token: "t", vaultId: "v" });
	s.check(!Object.keys(settings).some((k) => k.startsWith("lan")), "loading old data adds no lan keys");
	const kept = readVaultSyncSettings({ carrier: "lan", lanKey: "k".repeat(40), lanPins: { a: "FP" } }).settings;
	s.check(kept.lanKey === "k".repeat(40) && kept.lanPins?.a === "FP" && kept.carrier === "lan", "chosen values survive loading");
}

s.section("3: identity is made once and kept");
{
	let n = 0;
	const rnd = (length: number): string => `r${n++}`.padEnd(length, "x");
	const settings: LanCarrierSettings = {};
	s.check(ensureLanIdentity(settings, "Laptop", rnd) === true, "first call creates everything");
	s.check(/^lan[A-Za-z0-9]+$/.test(settings.lanDeviceId ?? "") && (settings.lanKey ?? "").length === 64 && !!settings.lanCertPem && !!settings.lanTlsKeyPem, "device id, 64-character key, certificate and key");
	const before = JSON.stringify(settings);
	s.check(ensureLanIdentity(settings, "Laptop", rnd) === false && JSON.stringify(settings) === before, "second call changes nothing");
	settings.lanKey = "default-key";
	s.check(ensureLanIdentity(settings, "Laptop", rnd) === true && settings.lanKey !== "default-key" && (settings.lanKey ?? "").length === 64, "a weak key is replaced by a random one");
	settings.lanTlsKeyPem = "damaged";
	s.check(ensureLanIdentity(settings, "Laptop", rnd) === true && settings.lanTlsKeyPem !== "damaged", "a damaged certificate pair is made anew");
}

s.section("4: the setup code");
{
	const key = generateLanKey();
	const code = makeLanSetupCode("vault-abc_1", key);
	s.check(code === `YAOS-LAN1:vault-abc_1:${key}`, "format");
	s.check(JSON.stringify(parseLanSetupCode(code)) === JSON.stringify({ vaultId: "vault-abc_1", key }), "round trip");
	s.check(parseLanSetupCode(`  ${code}\n`)?.key === key, "surrounding blanks are ignored");
	s.check(parseLanSetupCode(`YAOS-LAN1:v:${key.toUpperCase()}`)?.key === key, "a key in capitals is accepted and lowered");
	for (const bad of ["", "hello", `YAOS-P2P1:v:${key}`, `YAOS-LAN1:${key}`, "YAOS-LAN1:v:short", "YAOS-LAN1::" + key, `YAOS-LAN1:v v:${key}`, `YAOS-LAN1:v:${"z".repeat(64)}`]) {
		s.check(parseLanSetupCode(bad) === null, `rejected: '${bad.slice(0, 30)}'`);
	}
	s.check(explainBadSetupCode("") === undefined && explainBadSetupCode(code) === undefined, "empty and good codes raise no complaint");
	s.check(/starts with YAOS-LAN1/.test(explainBadSetupCode("abc") ?? ""), "a wrong prefix is explained");
	s.check(/damaged or incomplete/.test(explainBadSetupCode("YAOS-LAN1:v:12") ?? ""), "a damaged code is explained");
	const settings = { vaultId: "old", lanKey: "x".repeat(64), lanPins: { a: "FP" } } as LanCarrierSettings & { vaultId: string };
	s.check(applyLanSetupCode(settings, "nonsense") !== null && settings.vaultId === "old", "a bad code changes nothing");
	s.check(applyLanSetupCode(settings, code) === null && settings.vaultId === "vault-abc_1" && settings.lanKey === key && settings.lanPins === undefined, "a good code sets the vault and the key and forgets old pins");
	s.check(lanSetupCodeOf(settings) === code && lanSetupCodeOf({ vaultId: "v" }) === null, "the code this device shows");
}

s.section("5: ports, addresses and the discovery switch");
{
	const st: LanCarrierSettings = {};
	s.check(lanPortOf(st) === 8872 && lanDiscoveryPortOf(st) === 8873 && isLanDiscoveryOn(st), "defaults");
	writeLanSetting(st, "lanPort", 9000);
	writeLanSetting(st, "lanDiscoveryPort", 9001);
	writeLanSetting(st, "lanDiscovery", false);
	s.check(lanPortOf(st) === 9000 && lanDiscoveryPortOf(st) === 9001 && !isLanDiscoveryOn(st), "values are kept");
	writeLanSetting(st, "lanPort", 8872);
	writeLanSetting(st, "lanDiscoveryPort", 8873);
	writeLanSetting(st, "lanDiscovery", true);
	s.check(Object.keys(st).length === 0, "default values are stored as nothing (like a vault that never touched them)");
	s.check(await throws(() => writeLanSetting(st, "lanPort", 80)) && await throws(() => writeLanSetting(st, "lanPort", 70000)) && await throws(() => writeLanSetting(st, "lanPort", 1.5)), "ports outside 1024–65535 are refused");
	s.check(await throws(() => writeLanSetting(st, "lanPort", "9000")) && await throws(() => writeLanSetting(st, "lanDiscovery", "yes")), "wrong types are refused");
	writeLanSetting(st, "lanManualPeers", " 192.168.1.20, 10.0.0.5:9000 ;\n host.local ");
	s.check(lanManualPeerList(st).join() === "192.168.1.20:8872,10.0.0.5:9000,host.local:8872", "addresses are split, and the default port is filled in");
	s.check(validateManualPeers("192.168.1.20") === undefined && validateManualPeers("") === undefined, "good and empty lists pass");
	s.check(/is not an address/.test(validateManualPeers("192.168.1.20, ???") ?? "") && validateManualPeers("a:99999") !== undefined, "a bad entry is named");
	s.check(validateManualPeers(Array.from({ length: 21 }, (_, i) => `10.0.0.${i + 1}`).join(",")) !== undefined, "more than 20 are refused");
	writeLanSetting(st, "lanManualPeers", "  ");
	s.check(st.lanManualPeers === undefined, "an empty list is stored as nothing");
	s.check(readLanSetting({ lanPort: 9000 }, "lanPort") === 9000 && readLanSetting({}, "lanJoinCode") === "", "reading");
}

s.section("6: status sentences");
{
	s.check(/No pairing key/.test(describeLanStatus(emptyStatus, false)), "no key");
	s.check(/Not running/.test(describeLanStatus(emptyStatus, true)), "not started");
	s.check(describeLanStatus({ ...emptyStatus, running: true, error: "Port 8872 is already in use." }, true) === "Port 8872 is already in use.", "an error is shown as is");
	s.check(/Alone for now.*Looking for/.test(describeLanStatus({ ...emptyStatus, running: true, listening: true, discoveryRunning: true }, true)), "alone, searching");
	s.check(/Automatic search is off/.test(describeLanStatus({ ...emptyStatus, running: true, listening: true }, true)), "alone, search off");
	const linked = { ...emptyStatus, running: true, listening: true, linked: [{ deviceId: "a", deviceName: "Desk", address: "1.2.3.4", synced: true }] };
	s.check(describeLanStatus(linked, true) === "Linked with Desk. Up to date.", "linked");
	s.check(/Catching up/.test(describeLanStatus({ ...linked, linked: [{ deviceId: "a", deviceName: "Desk", address: "x", synced: false }] }, true)), "catching up");
}

s.section("7: the settings screen — nothing changes without the carrier");
{
	const noLan = makeFixture({ host: "https://sync.example", token: "tok", vaultId: "vid" }, false);
	const opts = flatten(noLan.tab.getSettingDefinitions()).find((d) => d.control?.key === "carrier");
	const keys = opts?.control && "options" in opts.control ? Object.keys(opts.control.options as Record<string, string>) : [];
	s.check(keys.join() === "cloudflare,drive,p2p", `a host without the carrier offers the same three options (${keys.join()})`);
	const withLan = makeFixture({ host: "https://sync.example", token: "tok", vaultId: "vid" });
	const o2 = flatten(withLan.tab.getSettingDefinitions()).find((d) => d.control?.key === "carrier");
	const k2 = o2?.control && "options" in o2.control ? Object.keys(o2.control.options as Record<string, string>) : [];
	s.check(k2.join() === "cloudflare,drive,p2p,lan", `the desktop app also offers Local network (${k2.join()})`);
	s.check(headings(withLan.tab.getSettingDefinitions()).join() === "Sync status,Updates,This device,What syncs,Attachments,Collaboration", "with another carrier chosen the Cloudflare screen has exactly the same groups");
	const before = JSON.stringify(names(noLan.tab.getSettingDefinitions()));
	const after = JSON.stringify(names(withLan.tab.getSettingDefinitions()));
	s.check(before === after, "and exactly the same rows");
}

s.section("8: the settings screen with the carrier chosen");
{
	const f = makeFixture({ carrier: "lan", vaultId: "vid", lanKey: generateLanKey(), host: "https://old.example", token: "t" });
	const items = f.tab.getSettingDefinitions();
	s.check(headings(items).join() === "Local network carrier,Devices on this network,This device,What syncs,Attachments,Collaboration", `groups (${headings(items).join()})`);
	s.check(pages(items).join() === "Local network (advanced),Advanced", `pages (${pages(items).join()})`);
	const all = names(items);
	s.check(!all.includes("Deploy your server") && !all.includes("Server URL") && !all.includes("Sync token") && !all.includes("Deployment repository URL") && !all.includes("Refresh attachment capability"), "no Cloudflare-only rows");
	s.check(all.includes("Sync carrier (experimental)") && all.includes("Copy setup code") && all.includes("Join with a setup code") && all.includes("Device name") && all.includes("Show remote cursors") && all.includes("Exclude paths"), "the carrier row, setup code, device name, cursors and exclude paths are there");
	s.check(all.includes("Vault ID") && all.includes("Edits from other apps") && all.includes("Debug mode") && all.includes("Status icon in the note header"), "Advanced keeps vault ID, external edits, debug and the status switches");
	s.check(all.includes("Find devices automatically") && all.includes("Connection port (TCP)") && all.includes("Search port (UDP)") && all.includes("Addresses of other devices"), "Local network advanced rows");
	const attach = flatten(items).find((d) => d.name === "Attachment storage");
	s.check(/own copy of every attachment/.test(String(attach?.desc ?? "")), "attachments are explained for this carrier");
	s.check(f.tab.getControlValue("carrier") === "lan", "the dropdown shows Local network");
	s.check(f.tab.getControlValue("lanPort") === 8872 && f.tab.getControlValue("lanDiscovery") === true && f.tab.getControlValue("lanManualPeers") === "" && f.tab.getControlValue("lanJoinCode") === "", "control values");

	f.status.value = { ...emptyStatus, running: true, listening: true, linked: [{ deviceId: "x", deviceName: "Desk", address: "192.168.1.5:8872", synced: true }], refusals: [{ at: 1, who: "Laptop", reason: "wrong key" }] };
	f.settings.lanPins = { "lanABC1234567": "FP" };
	const again = names(f.tab.getSettingDefinitions());
	s.check(again.includes("Desk") && again.includes("Refused: Laptop") && again.some((n) => n.startsWith("Forget device lanABC")), "linked devices, refusals and forget buttons are listed");
	const forget = flatten(f.tab.getSettingDefinitions()).find((d) => d.name.startsWith("Forget device"));
	if (forget && "action" in forget && forget.action) forget.action(document_stub(), 0);
	await Promise.resolve();
	s.check(f.calls.includes("forget:lanABC1234567"), "a forget button calls the host with that device");
}

function document_stub(): HTMLElement {
	return {} as HTMLElement;
}

s.section("9: changing the settings from the screen");
{
	const f = makeFixture({ carrier: "lan", vaultId: "vid", lanKey: "a".repeat(64) });
	const code = makeLanSetupCode("joined-vault", "b".repeat(64));
	await f.tab.setControlValue("lanJoinCode", code);
	s.check(f.settings.vaultId === "joined-vault" && f.settings.lanKey === "b".repeat(64) && f.reasons.at(-1) === "settings:lan-join", "a setup code is applied");
	const keep = JSON.stringify({ vaultId: f.settings.vaultId, key: f.settings.lanKey });
	s.check(await throws(() => f.tab.setControlValue("lanJoinCode", "YAOS-LAN1:nope")), "a bad setup code is refused with an error");
	s.check(JSON.stringify({ vaultId: f.settings.vaultId, key: f.settings.lanKey }) === keep, "and nothing was saved");
	await f.tab.setControlValue("lanJoinCode", "   ");
	s.check(JSON.stringify({ vaultId: f.settings.vaultId, key: f.settings.lanKey }) === keep, "an empty box does nothing");

	await f.tab.setControlValue("lanManualPeers", "192.168.1.9");
	s.check(f.settings.lanManualPeers === "192.168.1.9" && f.calls.includes("peers"), "typed-in addresses are saved and applied at once");
	f.calls.length = 0;
	s.check(await throws(() => f.tab.setControlValue("lanManualPeers", "???")), "a bad address is refused");
	s.check(f.settings.lanManualPeers === "192.168.1.9" && !f.calls.includes("peers"), "and the saved list is unchanged");
	await f.tab.setControlValue("lanPort", 9100);
	s.check(f.settings.lanPort === 9100 && f.reasons.at(-1) === "settings:lan", "port saved");
	s.check(await throws(() => f.tab.setControlValue("lanPort", 22)) && f.settings.lanPort === 9100, "a low port is refused and the old one stays");
	await f.tab.setControlValue("lanDiscovery", false);
	s.check(f.settings.lanDiscoveryOff === true, "search switched off");

	const g = makeFixture({ host: "https://x.example", token: "t" });
	await g.tab.setControlValue("carrier", "lan");
	s.check(g.settings.carrier === "lan" && g.calls.includes("prepare") && g.settings.host === "https://x.example" && g.settings.token === "t", "choosing the carrier makes the identity and keeps the Cloudflare settings");
	const h = makeFixture({ host: "https://x.example", token: "t" });
	await h.tab.setControlValue("carrier", "drive");
	s.check(!h.calls.includes("prepare"), "choosing another carrier does not touch the Local network identity");
}

s.section("10: carrier set to Local network on a device that cannot run it");
{
	const f = makeFixture({ carrier: "lan", host: "https://sync.example", token: "t", vaultId: "v" }, false);
	let ok = true;
	let items: SettingDefinitionItem[] = [];
	try { items = f.tab.getSettingDefinitions(); } catch { ok = false; }
	s.check(ok && names(items).includes("Sync carrier (experimental)"), "the screen still draws, and the carrier row is there to switch back");
	const row = flatten(items).find((d) => d.control?.key === "carrier");
	const keys = row?.control && "options" in row.control ? Object.keys(row.control.options as Record<string, string>) : [];
	s.check(keys.includes("lan"), "and shows the current choice");
}
s.section("11: command palette names");
{
	const names = (host: Partial<CommandsRuntimeHost>): Record<string, string> => {
		const out: Record<string, string> = {};
		registerCommands({ addCommand: (c) => { out[c.id] = c.name; return c; } }, Object.assign({} as CommandsRuntimeHost, host));
		return out;
	};
	const cf = names({});
	const lan = names({ isLanCarrier: () => true });
	s.check(JSON.stringify(names({ isLanCarrier: () => false })) === JSON.stringify(cf), "an explicit 'not Local network' answer changes nothing");
	s.check(Object.keys(lan).length === Object.keys(cf).length && Object.keys(cf).length === 10, "the same ten commands exist");
	const changed = Object.keys(cf).filter((k) => cf[k] !== lan[k]).sort();
	s.check(changed.join() === "clear-local-server-receipt-state,reconnect,reset-cache", `only three are renamed (${changed.join()})`);
	s.check(lan.reconnect === "Look for my other devices again" && lan["reset-cache"] === "Reset local cache (re-sync from linked devices)", "the new names");
	const both = names({ isDriveCarrier: () => true, isLanCarrier: () => true });
	s.check(both.reconnect === "Retry syncing with Google Drive", "Drive wins if both were ever true (cannot happen: one carrier at a time)");
}
s.section("12: the carrier's own files are never synced as notes");
{
	s.check(isExcluded(".obsidian/plugins/yaos/lan/blobs/" + "a".repeat(64), [], ".obsidian"), "attachment copies sit inside the config folder, which sync always skips");
	s.check(isExcluded(".obsidian/plugins/yaos/lan/snapshots/snapdat-1.bin", [], ".obsidian"), "restore points too");
}
await s.done();
