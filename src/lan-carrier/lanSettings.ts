/**
 * Settings of the Local network carrier.
 *
 * Like the other carriers, these fields are optional and NOT part of the default
 * settings: a vault that never chooses this carrier has exactly the saved data it
 * had before.
 */
import { LAN_DEFAULT_DISCOVERY_PORT, LAN_DEFAULT_PORT } from "./lanConstants";
import { generateLanKey, isAcceptableLanKey } from "./lanAuth";
import { generateLanCert, isUsableLanCert } from "./lanCert";
import { parseHostPort } from "./lanHub";

export interface LanCarrierSettings {
	/** Names this device on the network. Created once. */
	lanDeviceId?: string;
	/** The shared pairing key. Every device of the vault holds the same one. */
	lanKey?: string;
	/** TCP port of the link server. Absent = the default. */
	lanPort?: number;
	/** UDP port used to find devices. Absent = the default. */
	lanDiscoveryPort?: number;
	/** True when finding devices automatically is switched off. */
	lanDiscoveryOff?: boolean;
	/** Addresses typed in by hand (`192.168.1.20` or `192.168.1.20:8872`), separated by commas or spaces. */
	lanManualPeers?: string;
	/** This device's own certificate and key (self-signed). Created once. */
	lanCertPem?: string;
	lanTlsKeyPem?: string;
	/** Certificate fingerprint of each device seen so far, by device id. */
	lanPins?: Record<string, string>;
}

export const LAN_SETUP_PREFIX = "YAOS-LAN1";
export const LAN_MIN_PORT = 1024;
export const LAN_MAX_PORT = 65535;
const MAX_MANUAL_PEERS = 20;

export function lanPortOf(settings: LanCarrierSettings): number {
	return isValidPort(settings.lanPort) ? settings.lanPort : LAN_DEFAULT_PORT;
}

export function lanDiscoveryPortOf(settings: LanCarrierSettings): number {
	return isValidPort(settings.lanDiscoveryPort) ? settings.lanDiscoveryPort : LAN_DEFAULT_DISCOVERY_PORT;
}

export function isLanDiscoveryOn(settings: LanCarrierSettings): boolean {
	return settings.lanDiscoveryOff !== true;
}

function isValidPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= LAN_MIN_PORT && value <= LAN_MAX_PORT;
}

/** The entries of the typed-in address list, as `host:port`, with the port filled in. */
export function lanManualPeerList(settings: LanCarrierSettings): string[] {
	const out: string[] = [];
	for (const entry of splitEntries(settings.lanManualPeers ?? "")) {
		const parsed = parseManualEntry(entry);
		if (parsed) out.push(`${parsed.host}:${parsed.port}`);
	}
	return out.slice(0, MAX_MANUAL_PEERS);
}

/** `host` or `host:port`; the port defaults to the carrier's own. */
function parseManualEntry(entry: string): { host: string; port: number } | null {
	const trimmed = entry.trim();
	return parseHostPort(trimmed.includes(":") ? trimmed : `${trimmed}:${LAN_DEFAULT_PORT}`);
}

function splitEntries(text: string): string[] {
	return text.split(/[\s,;]+/).map((e) => e.trim()).filter((e) => e.length > 0);
}

/** Returns a message for the first entry that is not an address, or undefined when all are fine. */
export function validateManualPeers(text: string): string | undefined {
	const entries = splitEntries(text);
	if (entries.length > MAX_MANUAL_PEERS) return `At most ${MAX_MANUAL_PEERS} addresses.`;
	for (const entry of entries) {
		if (!parseManualEntry(entry)) return `"${entry}" is not an address. Use for example 192.168.1.20 or 192.168.1.20:8872.`;
	}
	return undefined;
}

export function validatePort(value: number): string | undefined {
	if (!isValidPort(value)) return `Enter a whole number from ${LAN_MIN_PORT} to ${LAN_MAX_PORT}.`;
	return undefined;
}

// ---------------------------------------------------------------------------
// The setup code: `YAOS-LAN1:<vault id>:<key>`
// ---------------------------------------------------------------------------

export function makeLanSetupCode(vaultId: string, key: string): string {
	return `${LAN_SETUP_PREFIX}:${vaultId}:${key}`;
}

/** The setup code this device shows (null until a key exists). */
export function lanSetupCodeOf(settings: LanCarrierSettings & { vaultId: string }): string | null {
	if (!settings.lanKey || !settings.vaultId) return null;
	return makeLanSetupCode(settings.vaultId, settings.lanKey);
}

export function parseLanSetupCode(text: string): { vaultId: string; key: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(`${LAN_SETUP_PREFIX}:`)) return null;
	const rest = trimmed.slice(LAN_SETUP_PREFIX.length + 1);
	const cut = rest.lastIndexOf(":");
	if (cut <= 0) return null;
	const vaultId = rest.slice(0, cut);
	const key = rest.slice(cut + 1);
	if (!/^[A-Za-z0-9_.-]{1,64}$/.test(vaultId)) return null;
	if (!/^[0-9a-fA-F]+$/.test(key) || !isAcceptableLanKey(key)) return null;
	return { vaultId, key: key.toLowerCase() };
}

/** Why a pasted setup code was not accepted, in words for the user. */
export function explainBadSetupCode(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	if (!trimmed.startsWith(`${LAN_SETUP_PREFIX}:`)) return `A local network setup code starts with ${LAN_SETUP_PREFIX}:`;
	return parseLanSetupCode(trimmed) ? undefined : "This setup code is damaged or incomplete. Copy it again from the other device.";
}

// ---------------------------------------------------------------------------
// Identity: device id, key and certificate, created once when the carrier is first used
// ---------------------------------------------------------------------------

export function newLanDeviceId(random: (length: number) => string): string {
	return `lan${random(10).replace(/[^A-Za-z0-9]/g, "x")}`;
}

/** Fills in what is missing. Returns true when something was added (the settings should then be saved). */
export function ensureLanIdentity(settings: LanCarrierSettings, deviceName: string, random: (length: number) => string): boolean {
	let changed = false;
	if (!settings.lanDeviceId) {
		settings.lanDeviceId = newLanDeviceId(random);
		changed = true;
	}
	if (!isAcceptableLanKey(settings.lanKey)) {
		settings.lanKey = generateLanKey();
		changed = true;
	}
	if (!isUsableLanCert(settings.lanCertPem, settings.lanTlsKeyPem)) {
		const cert = generateLanCert(`YAOS ${deviceName || "device"}`);
		settings.lanCertPem = cert.certPem;
		settings.lanTlsKeyPem = cert.keyPem;
		// A new certificate means the old identity is gone; other devices pin the new one at the next sign-in.
		changed = true;
	}
	return changed;
}

// ---------------------------------------------------------------------------
// Declarative settings: reading and writing the rows of the settings screen
// ---------------------------------------------------------------------------

export type LanSettingKey = "lanJoinCode" | "lanManualPeers" | "lanPort" | "lanDiscoveryPort" | "lanDiscovery";

export function isLanSettingKey(key: string): key is LanSettingKey {
	return key === "lanJoinCode" || key === "lanManualPeers" || key === "lanPort" || key === "lanDiscoveryPort" || key === "lanDiscovery";
}

export function readLanSetting(settings: LanCarrierSettings, key: LanSettingKey): string | number | boolean {
	switch (key) {
		case "lanJoinCode": return "";
		case "lanManualPeers": return settings.lanManualPeers ?? "";
		case "lanPort": return lanPortOf(settings);
		case "lanDiscoveryPort": return lanDiscoveryPortOf(settings);
		case "lanDiscovery": return isLanDiscoveryOn(settings);
	}
}

/**
 * Stores a value from the settings screen. Throws a RangeError (with a sentence for the
 * user) when the value is not acceptable. `lanJoinCode` is handled by the caller because
 * it also changes the vault id.
 */
export function writeLanSetting(settings: LanCarrierSettings, key: Exclude<LanSettingKey, "lanJoinCode">, value: unknown): void {
	switch (key) {
		case "lanManualPeers": {
			if (typeof value !== "string") throw new TypeError("lanManualPeers must be text");
			const problem = validateManualPeers(value);
			if (problem) throw new RangeError(problem);
			// "Nothing set" is stored as absent, like a vault that never touched this.
			if (value.trim() === "") delete settings.lanManualPeers;
			else settings.lanManualPeers = value.trim();
			return;
		}
		case "lanPort":
		case "lanDiscoveryPort": {
			if (typeof value !== "number") throw new TypeError(`${key} must be a number`);
			const problem = validatePort(value);
			if (problem) throw new RangeError(problem);
			const isDefault = value === (key === "lanPort" ? LAN_DEFAULT_PORT : LAN_DEFAULT_DISCOVERY_PORT);
			if (isDefault) delete settings[key];
			else settings[key] = value;
			return;
		}
		case "lanDiscovery": {
			if (typeof value !== "boolean") throw new TypeError("lanDiscovery must be true or false");
			if (value) delete settings.lanDiscoveryOff;
			else settings.lanDiscoveryOff = true;
			return;
		}
	}
}

/** Applies a pasted setup code. Returns an error sentence, or null when it was applied. */
export function applyLanSetupCode(settings: LanCarrierSettings & { vaultId: string }, text: string): string | null {
	const parsed = parseLanSetupCode(text);
	if (!parsed) return explainBadSetupCode(text) ?? "Paste a setup code first.";
	settings.vaultId = parsed.vaultId;
	settings.lanKey = parsed.key;
	// A new key means the devices that were pinned under the old one are no longer relevant to this vault.
	delete settings.lanPins;
	return null;
}
