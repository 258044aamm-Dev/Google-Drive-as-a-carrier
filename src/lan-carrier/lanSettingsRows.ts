/**
 * The settings screen of the Local network carrier: what is added to the screen and
 * which Cloudflare-only rows are taken away while this carrier is chosen. Kept here so
 * the settings tab only has to call it.
 */
import type {
	SettingDefinition,
	SettingDefinitionGroup,
	SettingDefinitionItem,
	SettingDefinitionPage,
} from "obsidian";
import type { LanStatusView } from "./lanCarrierRuntime";
import {
	explainBadSetupCode,
	validateManualPeers,
	validatePort,
	type LanCarrierSettings,
} from "./lanSettings";
import { LAN_DEFAULT_DISCOVERY_PORT, LAN_DEFAULT_PORT } from "./lanConstants";

/** What the settings screen needs from the plugin. Present on the host only where the carrier can run. */
export interface LanSettingsHost {
	/** True on the desktop app: the carrier can be offered and run. */
	available: boolean;
	/** Makes the device id, key and certificate if they do not exist yet. */
	prepare(): Promise<void>;
	status(): LanStatusView;
	copySetupCode(): void;
	/** Replaces the pairing key with a new random one (after the user confirmed). */
	regenerateKey(): Promise<void>;
	forgetDevice(deviceId: string): Promise<void>;
	/** The typed-in addresses changed. */
	applyManualPeers(): void;
}

export interface LanRowsContext {
	settings: LanCarrierSettings & { vaultId: string };
	lan: LanSettingsHost;
	carrierRow: SettingDefinition;
	/** Redraw the settings screen. */
	update: () => void;
}

function isGroup(item: SettingDefinitionItem): item is SettingDefinitionGroup {
	return "type" in item && item.type === "group";
}

function isPage(item: SettingDefinitionItem): item is SettingDefinitionPage {
	return "type" in item && item.type === "page";
}

function shortId(id: string): string {
	return id.length <= 10 ? id : `${id.slice(0, 6)}…${id.slice(-3)}`;
}

/** One plain sentence about where the carrier stands. */
export function describeLanStatus(status: LanStatusView, hasKey: boolean): string {
	if (!hasKey) return "No pairing key yet. Reload the plugin to create one.";
	if (!status.running) return "Not running. Reload the plugin to start the Local network carrier.";
	if (status.error) return status.error;
	if (!status.listening) return "Starting…";
	if (status.linked.length === 0) {
		const find = status.discoveryRunning ? "Looking for your other devices on this network." : "Automatic search is off: add the other device's address in Advanced.";
		return `Alone for now. ${find} Open YAOS with the same setup code on another computer.`;
	}
	const names = status.linked.map((l) => l.deviceName).join(", ");
	const synced = status.linked.every((l) => l.synced);
	return `Linked with ${names}. ${synced ? "Up to date." : "Catching up…"}`;
}

export function lanHeadItems(ctx: LanRowsContext): SettingDefinitionItem[] {
	const { settings, lan } = ctx;
	const hasKey = !!settings.lanKey;
	const groups: SettingDefinitionItem[] = [
		{
			type: "group",
			heading: "Local network carrier",
			items: [
				{ name: "Status", desc: describeLanStatus(lan.status(), hasKey) },
				ctx.carrierRow,
				{
					name: "Copy setup code",
					desc: "Copies a code that holds this vault's name and its pairing key. Paste it into \"Join with a setup code\" on your other computers. Anyone who has the code can join this vault, so keep it private.",
					visible: () => hasKey,
					action: () => { lan.copySetupCode(); },
				},
				{
					name: "Join with a setup code",
					desc: "On another computer: paste the code from your first computer, then reload the plugin.",
					control: {
						type: "text",
						key: "lanJoinCode",
						placeholder: "YAOS-LAN1:…",
						validate: (value: string) => explainBadSetupCode(value),
					},
				},
				{
					name: "Create a new pairing key",
					desc: "Replaces the key. Every other device must then join again with a new setup code. Use this if the code was shared by mistake.",
					visible: () => hasKey,
					action: () => { void lan.regenerateKey().then(ctx.update); },
				},
			],
		},
	];
	const status = lan.status();
	const deviceRows: SettingDefinition[] = [];
	for (const link of status.linked) {
		deviceRows.push({ name: link.deviceName, desc: `${link.address} · ${link.synced ? "up to date" : "catching up"}` });
	}
	for (const seen of status.seen) {
		if (status.linked.some((l) => l.deviceId === seen.deviceId)) continue;
		deviceRows.push({ name: seen.deviceName, desc: `${seen.address} · ${seen.online ? "seen on the network, linking…" : "not seen lately"}` });
	}
	if (deviceRows.length === 0) deviceRows.push({ name: "No other device yet", desc: "Both computers must be on the same network and have YAOS open." });
	groups.push({ type: "group", heading: "Devices on this network", items: deviceRows });
	return groups;
}

export function lanAdvancedPage(ctx: LanRowsContext): SettingDefinitionPage {
	const { settings, lan } = ctx;
	const status = lan.status();
	const pins = Object.keys(settings.lanPins ?? {});
	const problems = status.refusals.map((r): SettingDefinition => ({
		name: `Refused: ${r.who}`,
		desc: r.reason,
	}));
	return {
		type: "page",
		name: "Local network (advanced)",
		desc: "Ports, addresses, trusted devices and connection problems.",
		items: [
			{
				name: "Find devices automatically",
				desc: "Announces this computer on your network (UDP) and listens for the others. Turn it off on networks that block this, then add addresses by hand below. Reload the plugin after changing it.",
				control: { type: "toggle", key: "lanDiscovery" },
			},
			{
				name: "Addresses of other devices",
				desc: "Optional. Where to find a device without searching, separated by commas, for example 192.168.1.20 or 192.168.1.20:8872.",
				control: { type: "text", key: "lanManualPeers", placeholder: "192.168.1.20", validate: (value: string) => validateManualPeers(value) },
			},
			{
				name: "Connection port (TCP)",
				desc: `This computer accepts connections from your other devices on this port. Default ${LAN_DEFAULT_PORT}. Reload the plugin after changing it. Your firewall must allow it.`,
				control: { type: "number", key: "lanPort", min: 1024, max: 65535, step: 1, validate: (value: number) => validatePort(value) },
			},
			{
				name: "Search port (UDP)",
				desc: `Used to find devices. Default ${LAN_DEFAULT_DISCOVERY_PORT}. It must be the same on every device. Reload the plugin after changing it.`,
				control: { type: "number", key: "lanDiscoveryPort", min: 1024, max: 65535, step: 1, validate: (value: number) => validatePort(value) },
			},
			{
				name: "This device's fingerprint",
				desc: status.fingerprint || "Created when the carrier first starts. Other devices remember it and refuse a different one.",
			},
			...pins.map((id): SettingDefinition => ({
				name: `Forget device ${shortId(id)}`,
				desc: "Use this if that computer was reinstalled and is now refused with \"a different certificate\". It is trusted again at the next sign-in.",
				action: () => { void lan.forgetDevice(id).then(ctx.update); },
			})),
			...problems,
		],
	};
}

/**
 * The Cloudflare screen with this carrier chosen: the Cloudflare-only parts are taken away,
 * the Local network parts come first, everything about notes, attachments and safety stays.
 */
export function lanLayout(definitions: SettingDefinitionItem[], ctx: LanRowsContext): SettingDefinitionItem[] {
	const dropGroups = new Set(["Setup", "Sync status", "Updates"]);
	const serverRows = new Set(["Deployment repository URL", "Deployment default branch"]);
	const attachmentServerRows = new Set(["Refresh attachment capability", "Set up attachment storage"]);
	const rest: SettingDefinitionItem[] = [];
	for (const item of definitions) {
		if (isGroup(item) && typeof item.heading === "string" && dropGroups.has(item.heading)) continue;
		if (isPage(item) && item.name === "Manual connection") continue;
		if (isGroup(item) && item.heading === "Attachments") {
			const items = (item.items ?? [])
				.filter((entry) => !("name" in entry && typeof entry.name === "string" && attachmentServerRows.has(entry.name)))
				.map((entry) => ("name" in entry && entry.name === "Attachment storage" && !("items" in entry)
					? { ...entry, desc: "Each device keeps its own copy of every attachment and gets missing ones from your other devices when they are linked. A device that was off while an attachment was added fetches it the next time it is linked with one that has it." }
					: entry));
			rest.push({ ...item, items });
			continue;
		}
		if (isPage(item) && item.name === "Advanced" && item.items) {
			const items = item.items
				.filter((entry) => !("name" in entry && typeof entry.name === "string" && serverRows.has(entry.name)))
				.map((entry) => ("name" in entry && entry.name === "Reload required" && !("items" in entry)
					? { ...entry, desc: "Changing the sync carrier, the vault ID, the pairing key or the ports requires reloading the plugin." }
					: entry));
			rest.push({ ...item, desc: "Vault identity, external edits, safety and diagnostics.", items });
			continue;
		}
		rest.push(item);
	}
	const advanced = rest.findIndex((item) => isPage(item) && item.name === "Advanced");
	rest.splice(advanced >= 0 ? advanced : rest.length, 0, lanAdvancedPage(ctx));
	return [...lanHeadItems(ctx), ...rest];
}
