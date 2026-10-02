import type { SyncTransportFactory } from "../sync/transport";
import { DriveTransport } from "./driveTransport";
import { GoogleDriveRest, type DriveHttp } from "./googleDriveRest";
import { GoogleTokenManager } from "./googleAuth";
import type { DriveCarrierSettings } from "./carrierSettings";

export interface DriveCarrierRuntimeDeps {
	getSettings: () => DriveCarrierSettings;
	http: DriveHttp;
	log: (message: string) => void;
	/** Called once when Google says the sign-in no longer works. */
	onSignInLost: () => void;
	/** How often to look for changes made on other devices. Default 3 seconds. */
	pollIntervalMs?: number;
}

/**
 * Builds the factory VaultSync uses to create the Drive carrier instead of the
 * Cloudflare provider. Nothing here runs unless the user chose the Drive
 * carrier and signed in.
 */
export function createDriveTransportFactory(deps: DriveCarrierRuntimeDeps): SyncTransportFactory {
	return ({ doc, vaultId, isLocalStoreOrigin }) => {
		const settings = deps.getSettings();
		const tokens = new GoogleTokenManager(
			deps.http,
			{ clientId: settings.driveClientId ?? "", clientSecret: settings.driveClientSecret ?? "" },
			settings.driveRefreshToken ?? "",
			undefined,
			deps.onSignInLost,
		);
		const api = new GoogleDriveRest(deps.http, tokens.provider);
		return new DriveTransport(doc, api, {
			vaultId,
			deviceId: settings.driveDeviceId ?? "device",
			pollIntervalMs: deps.pollIntervalMs,
			ignoreOrigin: isLocalStoreOrigin,
			log: deps.log,
		});
	};
}
