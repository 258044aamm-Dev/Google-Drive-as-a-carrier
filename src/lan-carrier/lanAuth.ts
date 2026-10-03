/**
 * Sign-in of a link: a challenge-response with the shared key.
 *
 * Ported from Local Sync's auth-handshake.ts (MIT, liuboacean): a random
 * challenge, HMAC-SHA256 with the pre-shared key, a timing-safe comparison, and a
 * lockout after 5 failures. Changes, on purpose:
 *  - There is NO fallback key. A missing or short key is refused.
 *  - The proof covers the certificate fingerprint the server is using, so it is
 *    only valid on the very connection it was made for (a man in the middle that
 *    presents its own certificate cannot pass it on).
 *  - It is mutual: the server proves it knows the key as well as the client.
 *  - The lockout is kept per remote address, so reconnecting does not reset it.
 */
import { LAN_AUTH_LOCKOUT_MS, LAN_AUTH_MAX_FAILURES } from "./lanConstants";
import { loadLanNode } from "./lanNode";

/** A key shorter than this (as characters) is refused. Generated keys are 64 hex characters. */
export const LAN_MIN_KEY_LENGTH = 32;

export function generateLanKey(): string {
	return loadLanNode().crypto.randomBytes(32).toString("hex");
}

export function isAcceptableLanKey(key: string | undefined): key is string {
	return typeof key === "string" && key.trim().length >= LAN_MIN_KEY_LENGTH;
}

export function randomNonce(): string {
	return loadLanNode().crypto.randomBytes(16).toString("hex");
}

export type LanProofRole = "server" | "client";

/**
 * HMAC-SHA256(key, role | own nonce | other nonce | server certificate fingerprint).
 * `role` says who the proof is from, so a proof cannot be played back the other way.
 */
export function computeProof(
	key: string,
	role: LanProofRole,
	nonceFrom: string,
	nonceTo: string,
	serverFingerprint: string,
): string {
	return loadLanNode().crypto
		.createHmac("sha256", key)
		.update(`yaos-lan1|${role}|${nonceFrom}|${nonceTo}|${serverFingerprint}`)
		.digest("hex");
}

export function verifyProof(
	key: string,
	role: LanProofRole,
	nonceFrom: string,
	nonceTo: string,
	serverFingerprint: string,
	proof: unknown,
): boolean {
	if (typeof proof !== "string") return false;
	const expected = computeProof(key, role, nonceFrom, nonceTo, serverFingerprint);
	if (proof.length !== expected.length) return false;
	return loadLanNode().crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}

/** Counts failed sign-ins per remote address. */
export class LanLockout {
	private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

	constructor(
		private readonly maxFailures = LAN_AUTH_MAX_FAILURES,
		private readonly lockoutMs = LAN_AUTH_LOCKOUT_MS,
		private readonly now: () => number = () => Date.now(),
	) {}

	isLocked(address: string): boolean {
		const entry = this.failures.get(address);
		if (!entry) return false;
		if (entry.lockedUntil > 0 && this.now() >= entry.lockedUntil) {
			this.failures.delete(address);
			return false;
		}
		return entry.lockedUntil > 0;
	}

	recordFailure(address: string): void {
		const entry = this.failures.get(address) ?? { count: 0, lockedUntil: 0 };
		entry.count++;
		if (entry.count >= this.maxFailures) entry.lockedUntil = this.now() + this.lockoutMs;
		this.failures.set(address, entry);
	}

	recordSuccess(address: string): void {
		this.failures.delete(address);
	}
}
