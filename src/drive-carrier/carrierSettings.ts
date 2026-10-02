/**
 * Which sync carrier is in use, read from the saved settings.
 *
 * The carrier fields are optional on purpose and are NOT part of the default
 * settings: a user who never touches them has exactly the same saved data as
 * before, and `carrier` being absent means the Cloudflare Worker.
 */
export type CarrierKind = "cloudflare" | "drive";

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
	 * Encrypts everything stored on Drive when the vault is first created there.
	 * Kept in the plugin's data like the Google sign-in; it is the same on every device.
	 */
	driveEncryptionPassphrase?: string;
}

export function currentCarrier(settings: DriveCarrierSettings): CarrierKind {
	return settings.carrier === "drive" ? "drive" : "cloudflare";
}

export function isDriveCarrier(settings: DriveCarrierSettings): boolean {
	return currentCarrier(settings) === "drive";
}

export function isCarrierKind(value: string): value is CarrierKind {
	return value === "cloudflare" || value === "drive";
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
