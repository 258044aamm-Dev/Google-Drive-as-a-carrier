/**
 * Self-signed certificate for the secure link, built without any dependency.
 *
 * Ported from the Local Sync plugin's cert-manager.ts (MIT, liuboacean): an
 * ECDSA P-256 key pair, an X.509 v3 certificate assembled by hand in ASN.1 DER,
 * valid for 10 years, identified by its SHA-256 fingerprint. Node has no API
 * that creates a certificate, which is why the structure is written out here.
 *
 * Differences from the original, on purpose: the certificate and key are
 * returned to the caller (who keeps them in the plugin's saved data) instead
 * of being written to a folder in the user's home directory.
 */
import { LAN_CERT_DAYS_VALID } from "./lanConstants";
import { loadLanNode } from "./lanNode";

export interface LanCert {
	certPem: string;
	keyPem: string;
	/** SHA-256 of the certificate, uppercase hex pairs separated by colons. */
	fingerprint: string;
}

// ---------------------------------------------------------------------------
// ASN.1 DER helpers
// ---------------------------------------------------------------------------

function encodeLength(length: number): Buffer {
	if (length < 0x80) return Buffer.from([length]);
	const bytes: number[] = [];
	let len = length;
	while (len > 0) {
		bytes.unshift(len & 0xff);
		len = Math.floor(len / 256);
	}
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
	return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function integerFromHex(hex: string): Buffer {
	let bytes = Buffer.from(hex, "hex");
	// A DER INTEGER is signed: add a zero byte when the high bit is set, and drop pointless leading zeros.
	while (bytes.length > 1 && bytes[0] === 0 && ((bytes[1] ?? 0) & 0x80) === 0) bytes = bytes.subarray(1);
	if (bytes.length > 0 && ((bytes[0] ?? 0) & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
	return tlv(0x02, bytes);
}

function smallInteger(value: number): Buffer {
	return integerFromHex(value.toString(16).padStart(2, "0"));
}

const sequence = (children: Buffer[]): Buffer => tlv(0x30, Buffer.concat(children));
const set = (children: Buffer[]): Buffer => tlv(0x31, Buffer.concat(children));

function oid(dotted: string): Buffer {
	const parts = dotted.split(".").map(Number);
	const bytes: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
	for (let i = 2; i < parts.length; i++) {
		let value = parts[i] ?? 0;
		const chunk: number[] = [value & 0x7f];
		value = Math.floor(value / 128);
		while (value > 0) {
			chunk.unshift((value & 0x7f) | 0x80);
			value = Math.floor(value / 128);
		}
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
	const two = (n: number): string => n.toString().padStart(2, "0");
	const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
	return tlv(0x17, Buffer.from(text, "ascii"));
}

const bitString = (bytes: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const algorithm = (id: string, params?: Buffer): Buffer => sequence(params ? [oid(id), params] : [oid(id)]);

/** Name with a single CN attribute. */
function commonName(value: string): Buffer {
	return sequence([set([sequence([oid("2.5.4.3"), tlv(0x0c, Buffer.from(value, "utf8"))])])]);
}

const ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const PRIME256V1 = "1.2.840.10045.3.1.7";

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** Format a SHA-256 digest like `AB:CD:…` (the form Node reports for a TLS certificate). */
export function formatFingerprint(digestHex: string): string {
	return (digestHex.match(/.{2}/g) ?? []).join(":").toUpperCase();
}

export function fingerprintOfDer(der: Uint8Array): string {
	const { crypto } = loadLanNode();
	return formatFingerprint(crypto.createHash("sha256").update(der).digest("hex"));
}

export function fingerprintOfPem(certPem: string): string {
	const base64 = certPem
		.replace(/-----BEGIN CERTIFICATE-----/g, "")
		.replace(/-----END CERTIFICATE-----/g, "")
		.replace(/\s+/g, "");
	return fingerprintOfDer(Buffer.from(base64, "base64"));
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function derToPem(der: Buffer, label: string): string {
	const base64 = der.toString("base64");
	const lines: string[] = [];
	for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Create a new self-signed ECDSA P-256 certificate and its private key. */
export function generateLanCert(commonNameValue = "YAOS Local network", now: Date = new Date()): LanCert {
	const { crypto } = loadLanNode();
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
		namedCurve: "P-256",
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	const jwk = crypto.createPublicKey(publicKey).export({ format: "jwk" });
	const rawPoint = Buffer.concat([
		Buffer.from([0x04]),
		Buffer.from(String(jwk.x), "base64url"),
		Buffer.from(String(jwk.y), "base64url"),
	]);
	const notAfter = new Date(now.getTime() + LAN_CERT_DAYS_VALID * 86_400_000);
	const name = commonName(commonNameValue);
	const tbs = sequence([
		tlv(0xa0, smallInteger(2)),
		integerFromHex(crypto.randomBytes(16).toString("hex")),
		algorithm(ECDSA_SHA256),
		name,
		sequence([utcTime(now), utcTime(notAfter)]),
		name,
		sequence([algorithm(EC_PUBLIC_KEY, oid(PRIME256V1)), bitString(rawPoint)]),
	]);
	const signer = crypto.createSign("sha256");
	signer.update(tbs);
	const signature = signer.sign(crypto.createPrivateKey(privateKey));
	const certDer = sequence([tbs, algorithm(ECDSA_SHA256), bitString(signature)]);
	const certPem = derToPem(certDer, "CERTIFICATE");
	return { certPem, keyPem: privateKey, fingerprint: fingerprintOfPem(certPem) };
}

/** Check that a stored certificate and key can be used (parse, and belong together). */
export function isUsableLanCert(certPem: string | undefined, keyPem: string | undefined): boolean {
	if (!certPem || !keyPem) return false;
	try {
		const { crypto, tls } = loadLanNode();
		const cert = new crypto.X509Certificate(certPem);
		if (new Date(cert.validTo).getTime() < Date.now()) return false;
		if (!cert.checkPrivateKey(crypto.createPrivateKey(keyPem))) return false;
		tls.createSecureContext({ cert: certPem, key: keyPem });
		return true;
	} catch {
		return false;
	}
}
