import type * as Y from "yjs";
import type { BlobStoreClient } from "../sync/blobSync";
import type { SnapshotBackend } from "../snapshots/snapshotBackend";
import type { SyncTransportFactory } from "../sync/transport";
import { DriveBlobStore } from "./driveBlobStore";
import { DriveSnapshotBackend } from "./driveSnapshotBackend";
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

/** Everything the Drive carrier provides to the rest of the plugin, sharing one sign-in. */
export interface DriveCarrier {
	/** The sync transport (what the Worker connection is for Cloudflare). */
	transportFactory: SyncTransportFactory;
	/** Attachment storage on Drive. One instance per vault. */
	blobStore(vaultId: string): BlobStoreClient;
	/** Restore points on Drive. One instance per vault. */
	snapshotBackend(vaultId: string, getDoc: () => Y.Doc | null): SnapshotBackend;
}

/**
 * Builds the pieces the plugin uses instead of the Cloudflare ones. Nothing
 * here runs unless the user chose the Drive carrier and signed in.
 */
export function createDriveCarrier(deps: DriveCarrierRuntimeDeps): DriveCarrier {
	let api: GoogleDriveRest | null = null;
	const getApi = (): GoogleDriveRest => {
		if (api) return api;
		const settings = deps.getSettings();
		const tokens = new GoogleTokenManager(
			deps.http,
			{ clientId: settings.driveClientId ?? "", clientSecret: settings.driveClientSecret ?? "" },
			settings.driveRefreshToken ?? "",
			undefined,
			deps.onSignInLost,
		);
		api = new GoogleDriveRest(deps.http, tokens.provider);
		return api;
	};
	const blobStores = new Map<string, BlobStoreClient>();
	const snapshotBackends = new Map<string, SnapshotBackend>();

	return {
		transportFactory: ({ doc, vaultId, isLocalStoreOrigin }) => new DriveTransport(doc, getApi(), {
			vaultId,
			deviceId: deps.getSettings().driveDeviceId ?? "device",
			pollIntervalMs: deps.pollIntervalMs,
			ignoreOrigin: isLocalStoreOrigin,
			log: deps.log,
		}),
		blobStore(vaultId) {
			let store = blobStores.get(vaultId);
			if (!store) {
				store = new DriveBlobStore(getApi(), { vaultId });
				blobStores.set(vaultId, store);
			}
			return store;
		},
		snapshotBackend(vaultId, getDoc) {
			let backend = snapshotBackends.get(vaultId);
			if (!backend) {
				backend = new DriveSnapshotBackend(getApi(), { vaultId, getDoc });
				snapshotBackends.set(vaultId, backend);
			}
			return backend;
		},
	};
}

/** The transport part alone (kept for callers and tests that only need it). */
export function createDriveTransportFactory(deps: DriveCarrierRuntimeDeps): SyncTransportFactory {
	return createDriveCarrier(deps).transportFactory;
}
