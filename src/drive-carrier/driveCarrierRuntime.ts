import type * as Y from "yjs";
import type { BlobStoreClient } from "../sync/blobSync";
import type { SnapshotBackend } from "../snapshots/snapshotBackend";
import type { SyncTransportFactory } from "../sync/transport";
import { DriveBlobStore } from "./driveBlobStore";
import { DriveSnapshotBackend } from "./driveSnapshotBackend";
import { DriveKeyring } from "./driveKeyring";
import { DriveTransport } from "./driveTransport";
import { MeteredDriveApi, type RequestStats } from "./requestMeter";
import { browserActivity, type ActivitySource } from "./activity";
import { GoogleDriveRest, type DriveHttp } from "./googleDriveRest";
import { GoogleTokenManager } from "./googleAuth";
import { HOSTED_TOKEN_URL, HostedTokenManager } from "./hostedAuth";
import { isHostedSignIn, type DriveCarrierSettings } from "./carrierSettings";
import { NORMAL_DRIVE_PACE, resolveDrivePace, type SyncPaceSettings } from "../settings/syncPace";

export interface DriveCarrierRuntimeDeps {
	getSettings: () => DriveCarrierSettings & SyncPaceSettings;
	http: DriveHttp;
	log: (message: string) => void;
	/** Called once when Google says the sign-in no longer works. */
	onSignInLost: () => void;
	/** How often to look for changes made on other devices while the window is in use. Default 3 seconds. */
	pollIntervalMs?: number;
	/** Called once when the carrier stops for a reason retrying cannot fix (wrong passphrase, another layout). */
	onFatal?: (message: string) => void;
	/** Phones suspend apps, so polling stops while the window is hidden there. */
	isMobile?: () => boolean;
	/** Window visibility and network events. Default: the browser's. */
	activity?: ActivitySource;
	/** Overrides for the request budget. */
	idleAfterMs?: number;
	idlePollIntervalMs?: number;
	backgroundPollIntervalMs?: number;
}

/** After a minute of nothing happening, look every 30 seconds instead of every 3. */
export const DEFAULT_IDLE_AFTER_MS = NORMAL_DRIVE_PACE.idleAfterMs;
export const DEFAULT_IDLE_POLL_MS = NORMAL_DRIVE_PACE.idlePollIntervalMs;
/** Desktop windows that are hidden (minimised, covered) still check every two minutes. */
export const DEFAULT_BACKGROUND_POLL_MS = NORMAL_DRIVE_PACE.backgroundPollIntervalMsDesktop;

/** Everything the Drive carrier provides to the rest of the plugin, sharing one sign-in. */
export interface DriveCarrier {
	/** The sync transport (what the Worker connection is for Cloudflare). */
	transportFactory: SyncTransportFactory;
	/** Attachment storage on Drive. One instance per vault. */
	blobStore(vaultId: string): BlobStoreClient;
	/** Restore points on Drive. One instance per vault. */
	snapshotBackend(vaultId: string, getDoc: () => Y.Doc | null): SnapshotBackend;
	/** How many requests the carrier has sent to Drive (null before the first one). */
	requestStats(): RequestStats | null;
	/** Re-read the "sync speed" setting and apply it to the running transports. */
	applyPace(): void;
}

/**
 * Builds the pieces the plugin uses instead of the Cloudflare ones. Nothing
 * here runs unless the user chose the Drive carrier and signed in.
 */
export function createDriveCarrier(deps: DriveCarrierRuntimeDeps): DriveCarrier {
	let api: MeteredDriveApi | null = null;
	const getApi = (): MeteredDriveApi => {
		if (api) return api;
		const settings = deps.getSettings();
		const tokens = isHostedSignIn(settings)
			? new HostedTokenManager(deps.http, settings.driveHostedUrl?.trim() || HOSTED_TOKEN_URL, settings.driveRefreshToken ?? "", undefined, deps.onSignInLost)
			: new GoogleTokenManager(
				deps.http,
				{ clientId: settings.driveClientId ?? "", clientSecret: settings.driveClientSecret ?? "" },
				settings.driveRefreshToken ?? "",
				undefined,
				deps.onSignInLost,
			);
		api = new MeteredDriveApi(new GoogleDriveRest(deps.http, tokens.provider));
		return api;
	};
	const keyrings = new Map<string, DriveKeyring>();
	const keyringFor = (vaultId: string): DriveKeyring => {
		let keyring = keyrings.get(vaultId);
		if (!keyring) {
			keyring = new DriveKeyring(getApi(), {
				vaultId,
				passphrase: deps.getSettings().driveEncryptionPassphrase ?? "",
			});
			keyrings.set(vaultId, keyring);
		}
		return keyring;
	};
	let activity: ActivitySource | null = null;
	// One live transport per vault (a reload replaces the old one), so a settings change reaches the running one.
	const transports = new Map<string, DriveTransport>();
	const currentPace = () => resolveDrivePace(deps.getSettings(), deps.isMobile?.() ?? false);
	const blobStores = new Map<string, BlobStoreClient>();
	const snapshotBackends = new Map<string, SnapshotBackend>();

	return {
		transportFactory: ({ doc, vaultId, isLocalStoreOrigin }) => {
			activity ??= deps.activity ?? browserActivity();
			const pace = currentPace();
			const transport = new DriveTransport(doc, getApi(), {
				vaultId,
				deviceId: deps.getSettings().driveDeviceId ?? "device",
				pollIntervalMs: deps.pollIntervalMs ?? pace.pollIntervalMs,
				idleAfterMs: deps.idleAfterMs ?? pace.idleAfterMs,
				idlePollIntervalMs: deps.idlePollIntervalMs ?? pace.idlePollIntervalMs,
				backgroundPollIntervalMs: deps.backgroundPollIntervalMs ?? pace.backgroundPollIntervalMs,
				batchMs: pace.batchMs,
				reconcileIntervalMs: pace.reconcileIntervalMs,
				activity,
				keyring: keyringFor(vaultId),
				onFatal: deps.onFatal,
				ignoreOrigin: isLocalStoreOrigin,
				log: deps.log,
			});
			transports.set(vaultId, transport);
			return transport;
		},
		blobStore(vaultId) {
			let store = blobStores.get(vaultId);
			if (!store) {
				store = new DriveBlobStore(getApi(), { vaultId, keyring: keyringFor(vaultId) });
				blobStores.set(vaultId, store);
			}
			return store;
		},
		snapshotBackend(vaultId, getDoc) {
			let backend = snapshotBackends.get(vaultId);
			if (!backend) {
				backend = new DriveSnapshotBackend(getApi(), { vaultId, getDoc, keyring: keyringFor(vaultId) });
				snapshotBackends.set(vaultId, backend);
			}
			return backend;
		},
		requestStats: () => api?.stats() ?? null,
		applyPace() {
			const pace = currentPace();
			for (const transport of transports.values()) {
				transport.applyPace({
					pollIntervalMs: deps.pollIntervalMs ?? pace.pollIntervalMs,
					idleAfterMs: deps.idleAfterMs ?? pace.idleAfterMs,
					idlePollIntervalMs: deps.idlePollIntervalMs ?? pace.idlePollIntervalMs,
					backgroundPollIntervalMs: deps.backgroundPollIntervalMs ?? pace.backgroundPollIntervalMs,
					batchMs: pace.batchMs,
					reconcileIntervalMs: pace.reconcileIntervalMs,
				});
			}
		},
	};
}

/** The transport part alone (kept for callers and tests that only need it). */
export function createDriveTransportFactory(deps: DriveCarrierRuntimeDeps): SyncTransportFactory {
	return createDriveCarrier(deps).transportFactory;
}
