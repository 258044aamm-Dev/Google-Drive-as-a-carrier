/**
 * Google Drive setup wizard: the setup code, the input checks and the
 * plain-words error messages.
 */

import { DriveError } from "../../src/drive-carrier/driveApi";
import { EncryptionError } from "../../src/drive-carrier/driveCrypto";
import { FatalCarrierError } from "../../src/drive-carrier/driveKeyring";
import { GoogleAuthError } from "../../src/drive-carrier/googleAuth";
import { explainSetupError } from "../../src/drive-carrier/wizard/explainError";
import {
	SETUP_CODE_PREFIX,
	crc32,
	decodeSetupCode,
	describeSetupCodeProblem,
	encodeSetupCode,
	type SetupCodeContent,
} from "../../src/drive-carrier/wizard/setupCode";
import { checkClientId, checkClientSecret, checkNewPassphrase, checkVaultId } from "../../src/drive-carrier/wizard/validate";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-wizard-code");

const sample: SetupCodeContent = {
	vaultId: "AbCdEfGh_-0123456789xy",
	clientId: "123456789-abcdef.apps.googleusercontent.com",
	clientSecret: "GOCSPX-abcdefghijklmnop",
	bundledClient: false,
	passphrase: "correct horse battery staple",
	encrypted: true,
};

s.section("Test 1: setup code round trip");
{
	const code = encodeSetupCode(sample);
	s.check(code.startsWith(SETUP_CODE_PREFIX), "starts with the prefix");
	s.check(!/\s/.test(code), "is one line without spaces");
	const back = decodeSetupCode(code);
	s.check(back.ok && JSON.stringify(back.content) === JSON.stringify(sample), "decodes to exactly what was encoded");
	const plain = decodeSetupCode(encodeSetupCode({ ...sample, passphrase: "", encrypted: false, bundledClient: true }));
	s.check(plain.ok && plain.content.passphrase === "" && !plain.content.encrypted && plain.content.bundledClient, "an unencrypted vault and the built-in client round-trip");
	const left = decodeSetupCode(encodeSetupCode({ ...sample, passphrase: "" }));
	s.check(left.ok && left.content.encrypted && left.content.passphrase === "", "a code made without the passphrase still says the vault is encrypted");
	const unicode = decodeSetupCode(encodeSetupCode({ ...sample, passphrase: "pässwörd ✓ 密码" }));
	s.check(unicode.ok && unicode.content.passphrase === "pässwörd ✓ 密码", "a passphrase with accents and symbols survives");
	s.check(crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "the checksum is standard CRC-32");
}

function payloadOf(code: string): string {
	const text = code.slice(SETUP_CODE_PREFIX.length, code.lastIndexOf(".")).replace(/-/g, "+").replace(/_/g, "/");
	const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
	return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}

s.section("Test 2: a code never carries a sign-in token");
{
	const code = encodeSetupCode(sample);
	const json = payloadOf(code);
	s.check(!/refresh|access|token/i.test(json), `no token field in the payload (${Object.keys(JSON.parse(json) as object).join(",")})`);
	const without = encodeSetupCode({ ...sample, passphrase: "" });
	const raw = payloadOf(without);
	s.check(!raw.includes("correct horse"), "leaving the passphrase out really leaves it out");
}

s.section("Test 3: damaged and wrong codes are refused with a reason");
{
	const code = encodeSetupCode(sample);
	const pasted = `  ${code.slice(0, 20)}\n${code.slice(20)}  `;
	s.check(decodeSetupCode(pasted).ok, "spaces and line breaks from copying are ignored");
	s.check(decodeSetupCode(code.slice(0, -3)).ok === false, "a cut-off code is refused");
	const flipped = code.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
	const r1 = decodeSetupCode(flipped);
	s.check(!r1.ok && r1.reason === "damaged", "a changed checksum is 'damaged'");
	const mid = code.indexOf(":") + 6;
	const swapped = code.slice(0, mid) + (code[mid] === "A" ? "B" : "A") + code.slice(mid + 1);
	const r2 = decodeSetupCode(swapped);
	s.check(!r2.ok && r2.reason === "damaged", "a changed letter in the middle is 'damaged'");
	const e = decodeSetupCode("");
	s.check(!e.ok && e.reason === "empty", "empty input");
	const n = decodeSetupCode("hello world");
	s.check(!n.ok && n.reason === "not-a-code", "random text is 'not-a-code'");
	const v = decodeSetupCode("YAOS-DRIVE2:abc.00000000");
	s.check(!v.ok && v.reason === "newer-version", "a newer code version is named as such");
	const noDot = decodeSetupCode(`${SETUP_CODE_PREFIX}abcdef`);
	s.check(!noDot.ok && noDot.reason === "damaged", "no checksum is 'damaged'");
	const missing = (() => {
		const payload = new TextEncoder().encode(JSON.stringify({ v: 1, vault: "x" }));
		let bin = "";
		for (const b of payload) bin += String.fromCharCode(b);
		const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		return `${SETUP_CODE_PREFIX}${b64}.${crc32(payload).toString(16).padStart(8, "0")}`;
	})();
	const r3 = decodeSetupCode(missing);
	s.check(!r3.ok && r3.reason === "incomplete", "a code without client details is 'incomplete'");
	for (const reason of ["empty", "not-a-code", "damaged", "newer-version", "incomplete"] as const) {
		s.check(describeSetupCodeProblem(reason).length > 20, `a sentence for '${reason}'`);
	}
}

s.section("Test 4: input checks");
{
	s.check(checkClientId("123456789-abc123def.apps.googleusercontent.com") === null, "a real-looking client ID is accepted");
	s.check(checkClientId("  123456789-abc123def.apps.googleusercontent.com  ") === null, "surrounding spaces are tolerated");
	s.check(checkClientId("") !== null && checkClientId("hello") !== null && checkClientId("123 456.apps.googleusercontent.com") !== null, "empty, wrong or spaced client IDs are refused");
	s.check(checkClientSecret("GOCSPX-abcdefghijklmnop") === null, "a client secret is accepted");
	s.check(checkClientSecret("short") !== null && checkClientSecret("") !== null && checkClientSecret("has a space in it") !== null, "empty, short or spaced secrets are refused");
	s.check(String(checkClientSecret("123456789-abc123def.apps.googleusercontent.com")).includes("client ID"), "pasting the ID into the secret box is noticed");
	s.check(checkVaultId("AbCdEfGh_-0123456789xy") === null, "a generated vault ID is accepted");
	s.check(checkVaultId("") !== null && checkVaultId("a b c d e f g h") !== null && checkVaultId("abc") !== null && checkVaultId("ab/cd/ef/gh/ij") !== null && checkVaultId("x".repeat(200)) !== null, "bad vault IDs are refused");
	s.check(checkNewPassphrase("longenough1", "longenough1") === null, "a matching long passphrase is accepted");
	s.check(checkNewPassphrase("short", "short") !== null, "short passphrases are refused");
	s.check(String(checkNewPassphrase("longenough1", "longenough2")).includes("different"), "different confirmation is refused");
}

s.section("Test 5: errors are explained in plain words");
{
	const say = (e: unknown): string => explainSetupError(e);
	s.check(/client ID or client secret/.test(say(new GoogleAuthError("x", "invalid_client", false))), "invalid_client names the client details");
	s.check(/TVs and Limited Input/.test(say(new GoogleAuthError("x", "unauthorized_client", false))), "unauthorized_client names the client type");
	s.check(/Publish app/.test(say(new GoogleAuthError("x", "access_denied", false))), "access_denied points to publishing the app");
	s.check(/expired/.test(say(new GoogleAuthError("x", "expired_token", false))), "an expired code says so");
	s.check(say(new GoogleAuthError("x", "cancelled", false)) === "Sign-in was cancelled.", "cancelled");
	s.check(/Drive API is not switched on/.test(say(new DriveError(403, "Drive request failed (403): accessNotConfigured"))), "403 accessNotConfigured: Drive API is off");
	s.check(/Drive API is not switched on/.test(say(new DriveError(403, "Google Drive API has not been used in project 123 before or it is disabled"))), "403 'has not been used': Drive API is off");
	s.check(/Drive is full/.test(say(new DriveError(403, "storageQuotaExceeded: The user's Drive storage quota has been exceeded"))), "403 quota: Drive is full");
	s.check(/slow down/.test(say(new DriveError(403, "userRateLimitExceeded"))) && /slow down/.test(say(new DriveError(429, "x"))), "rate limits ask to wait");
	s.check(/No connection/.test(say(new DriveError(0, "Network error"))), "network failure");
	s.check(/temporary problem/.test(say(new DriveError(503, "x"))), "5xx is temporary");
	s.check(/did not accept the sign-in/.test(say(new DriveError(401, "x"))), "401");
	s.check(say(new FatalCarrierError("wrong passphrase text")) === "wrong passphrase text", "carrier errors keep their own sentence");
	s.check(say(new EncryptionError("bad key")) === "bad key", "encryption errors keep their own sentence");
	s.check(say(new Error("boom")) === "boom" && say("odd") === "odd", "anything else is passed through");
	const all = [
		say(new GoogleAuthError("x", "invalid_client", false)), say(new GoogleAuthError("x", "access_denied", false)),
		say(new DriveError(403, "accessNotConfigured")), say(new DriveError(0, "x")),
	].join(" ");
	s.check(!/cloudflare|worker/i.test(all), "no Cloudflare wording in wizard errors");
}

await s.done();
