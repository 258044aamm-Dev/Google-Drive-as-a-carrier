/**
 * The setup code: one line of text that carries what a second device needs to
 * join a vault (vault ID, Google client, and optionally the passphrase).
 *
 * It never contains a Google sign-in token: every device signs in itself.
 * Format: `YAOS-DRIVE1:<base64url of JSON>.<8 hex characters of CRC-32>`.
 * A vault that uses the easy sign-in has no client details to carry, so its
 * code starts with `YAOS-DRIVE2:` instead. Both kinds are read.
 * The checksum only catches typing and copy mistakes; it is not a secret.
 */

export const SETUP_CODE_PREFIX = "YAOS-DRIVE1:";
export const HOSTED_SETUP_CODE_PREFIX = "YAOS-DRIVE2:";

export interface SetupCodeContent {
	vaultId: string;
	clientId: string;
	clientSecret: string;
	/** True when the client is the one built into the plugin (informational). */
	bundledClient: boolean;
	/** Empty when the vault is not encrypted, or when the code was made without it. */
	passphrase: string;
	/** True when the vault is encrypted (so the other device knows to ask for the passphrase). */
	encrypted: boolean;
	/** True when the vault uses the easy sign-in (no client details in the code). */
	hosted?: boolean;
}

export type SetupCodeResult =
	| { ok: true; content: SetupCodeContent }
	| { ok: false; reason: "empty" | "not-a-code" | "damaged" | "newer-version" | "incomplete" };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	try {
		const binary = atob(padded);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

function checksumText(payload: Uint8Array): string {
	return crc32(payload).toString(16).padStart(8, "0");
}

export function encodeSetupCode(content: SetupCodeContent): string {
	if (content.hosted) {
		const payload = encoder.encode(JSON.stringify({
			v: 2,
			vault: content.vaultId,
			signin: "hosted",
			enc: content.encrypted,
			...(content.passphrase ? { pass: content.passphrase } : {}),
		}));
		return `${HOSTED_SETUP_CODE_PREFIX}${toBase64Url(payload)}.${checksumText(payload)}`;
	}
	const json = JSON.stringify({
		v: 1,
		vault: content.vaultId,
		client: { id: content.clientId, secret: content.clientSecret, bundled: content.bundledClient },
		enc: content.encrypted,
		...(content.passphrase ? { pass: content.passphrase } : {}),
	});
	const payload = encoder.encode(json);
	return `${SETUP_CODE_PREFIX}${toBase64Url(payload)}.${checksumText(payload)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeSetupCode(raw: string): SetupCodeResult {
	// Copying from a chat or a note often adds spaces and line breaks.
	const text = raw.replace(/\s+/g, "");
	if (!text) return { ok: false, reason: "empty" };
	const hostedCode = text.startsWith(HOSTED_SETUP_CODE_PREFIX);
	if (!hostedCode && !text.startsWith(SETUP_CODE_PREFIX)) {
		return { ok: false, reason: /^YAOS-DRIVE\d+:/.test(text) ? "newer-version" : "not-a-code" };
	}
	const body = text.slice(SETUP_CODE_PREFIX.length);
	const dot = body.lastIndexOf(".");
	if (dot < 0) return { ok: false, reason: "damaged" };
	const payload = fromBase64Url(body.slice(0, dot));
	if (!payload || checksumText(payload) !== body.slice(dot + 1).toLowerCase()) return { ok: false, reason: "damaged" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(payload));
	} catch {
		return { ok: false, reason: "damaged" };
	}
	if (!isRecord(parsed)) return { ok: false, reason: "damaged" };
	if (parsed.v !== (hostedCode ? 2 : 1)) return { ok: false, reason: "newer-version" };
	if (hostedCode) {
		const hostedVault = typeof parsed.vault === "string" ? parsed.vault : "";
		if (!hostedVault || parsed.signin !== "hosted") return { ok: false, reason: "incomplete" };
		const hostedPass = typeof parsed.pass === "string" ? parsed.pass : "";
		return {
			ok: true,
			content: { vaultId: hostedVault, clientId: "", clientSecret: "", bundledClient: false, hosted: true, passphrase: hostedPass, encrypted: parsed.enc === true || hostedPass !== "" },
		};
	}
	const client = isRecord(parsed.client) ? parsed.client : null;
	const vaultId = typeof parsed.vault === "string" ? parsed.vault : "";
	const clientId = client && typeof client.id === "string" ? client.id : "";
	const clientSecret = client && typeof client.secret === "string" ? client.secret : "";
	if (!vaultId || !clientId || !clientSecret) return { ok: false, reason: "incomplete" };
	const passphrase = typeof parsed.pass === "string" ? parsed.pass : "";
	return {
		ok: true,
		content: {
			vaultId,
			clientId,
			clientSecret,
			bundledClient: client?.bundled === true,
			passphrase,
			encrypted: parsed.enc === true || passphrase !== "",
		},
	};
}

export function describeSetupCodeProblem(reason: Extract<SetupCodeResult, { ok: false }>["reason"]): string {
	switch (reason) {
		case "empty": return "Paste the setup code from your other device.";
		case "not-a-code": return "That does not look like a YAOS setup code. It starts with YAOS-DRIVE.";
		case "damaged": return "The setup code is damaged, probably cut off when it was copied. Copy it again from the other device.";
		case "newer-version": return "This setup code was made by a newer version of the plugin. Update the plugin on this device.";
		case "incomplete": return "The setup code is missing some details. Make a new one on the other device.";
	}
}
