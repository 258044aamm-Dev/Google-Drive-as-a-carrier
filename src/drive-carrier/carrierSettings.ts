/**
 * Which sync carrier is in use, read from the saved settings.
 *
 * The carrier fields are optional on purpose and are NOT part of the default
 * settings: a user who never touches them has exactly the same saved data as
 * before, and `carrier` being absent means the Cloudflare Worker.
 */
export type CarrierKind = "cloudflare" | "drive" | "lan";

/** F1: the two compaction modes. */
export type DriveCompactionMode = "adaptive" | "legacy";

export interface DriveCarrierSettings {
	carrier?: CarrierKind;
	driveClientId?: string;
	driveClientSecret?: string;
	driveRefreshToken?: string;
	driveDeviceId?: string;
	/**
	 * How this device signs in. Absent = Google's own device sign-in with the
	 * user's client ID and secret (the default). "hosted" = the easy sign-in:
	 * the refresh token comes from a sign-in page and the token service holds
	 * the Google client secret, so no client details are saved.
	 */
	driveAuthMode?: "hosted";
	/** Overrides the token service address when `driveAuthMode` is "hosted". Rarely used. */
	driveHostedUrl?: string;
	/**
	 * F4: the custom token service address that last issued an access token for
	 * this device. Compared with `driveHostedUrl` at startup so a changed address
	 * is reported instead of silently receiving the refresh token. Absent = unknown.
	 */
	driveHostedUrlUsed?: string;
	/**
	 * Encrypts everything stored on Drive when the vault is first created there.
	 * Kept in the plugin's data like the Google sign-in; it is the same on every device.
	 */
	driveEncryptionPassphrase?: string;
	/**
	 * F6: how many restore points (snapshots) one compaction keeps, 2 to 10.
	 * Absent = 4. 2 is exactly what 2.1.22 kept; more costs Drive space, nothing else.
	 */
	driveKeepSnapshots?: number;
	/**
	 * F6: read a new restore point back from Drive and check it before deleting the
	 * sync files it covers. Absent = on. Set to false to skip the readback exactly
	 * as 2.1.22 did (for metered connections).
	 */
	driveVerifyBeforePrune?: boolean;
	/**
	 * F1: how compaction works. Absent = "adaptive": the change files are merged
	 * into one and a full snapshot is only written when it is really smaller.
	 * "legacy" is 2.1.22: a full snapshot at the first trigger. See
	 * DEFAULT_COMPACTION_MODE.
	 */
	driveCompaction?: DriveCompactionMode;
	/**
	 * F5: the Drive folder this vault lives in, remembered after the first sync so
	 * the carrier follows the folder id instead of searching by name. Absent on a
	 * device that has not synced yet, or after the field is cleared: the folder is
	 * then found by name again. Clearing it is always safe.
	 */
	driveFolderId?: string;
}

export function currentCarrier(settings: DriveCarrierSettings): CarrierKind {
	if (settings.carrier === "drive") return "drive";
	if (settings.carrier === "lan") return "lan";
	return "cloudflare";
}

export function isDriveCarrier(settings: DriveCarrierSettings): boolean {
	return currentCarrier(settings) === "drive";
}

/** The Local network carrier (see src/lan-carrier). */
export function isLanCarrier(settings: DriveCarrierSettings): boolean {
	return currentCarrier(settings) === "lan";
}

export function isCarrierKind(value: string): value is CarrierKind {
	return value === "cloudflare" || value === "drive" || value === "lan";
}

/** True when this device uses the easy sign-in (see `driveAuthMode`). */
export function isHostedSignIn(settings: DriveCarrierSettings): boolean {
	return settings.driveAuthMode === "hosted";
}

/** True when everything needed to talk to Drive has been entered and the user has signed in. */
export function isDriveSignedIn(settings: DriveCarrierSettings): boolean {
	if (isHostedSignIn(settings)) return !!settings.driveRefreshToken;
	return !!(settings.driveClientId?.trim() && settings.driveClientSecret?.trim() && settings.driveRefreshToken);
}

/** The name of the folder that holds this vault on Drive (shown to the user). */
export function driveFolderLabel(vaultId: string): string {
	return `YAOS ${vaultId}`;
}

/** Device ids go into Drive file names, so keep them to letters and digits. */
export function newDriveDeviceId(random: (length: number) => string): string {
	return random(10).replace(/[^A-Za-z0-9]/g, "x");
}
