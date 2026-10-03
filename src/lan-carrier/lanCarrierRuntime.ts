import type * as Y from "yjs";
import type { BlobStoreClient } from "../sync/blobSync";
import type { SnapshotBackend } from "../snapshots/snapshotBackend";
import type { SyncTransportFactory } from "../sync/transport";
import { LanBlobStore } from "./lanBlobStore";
import type { LanFileStore } from "./lanFileStore";
import { LanHub } from "./lanHub";
import { LanSnapshotBackend } from "./lanSnapshotBackend";
import { LanTransport } from "./lanTransport";
import { fingerprintOfPem, generateLanCert } from "./lanCert";
import {
	isLanDiscoveryOn,
	lanDiscoveryPortOf,
	lanManualPeerList,
	lanPortOf,
	type LanCarrierSettings,
} from "./lanSettings";

export interface LanCarrierDeps {
	getSettings: () => LanCarrierSettings & { deviceName: string; vaultId: string };
	updateSettings: (mutator: (settings: LanCarrierSettings) => void, reason: string) => Promise<void>;
	/** A folder of this vault's plugin data: "blobs" for attachments, "snapshots" for restore points. */
	filesFor: (folder: "blobs" | "snapshots") => LanFileStore;
	log: (message: string) => void;
	/** Called once per start when the carrier cannot start (no key, port in use). */
	onProblem: (message: string) => void;
}

/** What the settings screen shows. */
export interface LanStatusView {
	running: boolean;
	listening: boolean;
	port: number | null;
	error: string | null;
	discoveryRunning: boolean;
	fingerprint: string;
	linked: Array<{ deviceId: string; deviceName: string; address: string; synced: boolean }>;
	seen: Array<{ deviceId: string; deviceName: string; address: string; online: boolean }>;
	refusals: Array<{ at: number; who: string; reason: string }>;
}

export interface LanCarrier {
	transportFactory: SyncTransportFactory;
	blobStore(vaultId: string): BlobStoreClient;
	snapshotBackend(vaultId: string, getDoc: () => Y.Doc | null): SnapshotBackend;
	/** The typed-in addresses changed: use them right away. */
	applyManualPeers(): void;
	status(): LanStatusView;
}

/**
 * Builds the pieces the plugin uses instead of the Cloudflare ones. Nothing here
 * runs unless the user chose the Local network carrier.
 */
export function createLanCarrier(deps: LanCarrierDeps): LanCarrier {
	let transport: LanTransport | null = null;
	let blobStore: LanBlobStore | null = null;
	let snapshotBackend: LanSnapshotBackend | null = null;

	return {
		transportFactory: ({ doc, isLocalStoreOrigin }) => {
			const current = new LanTransport(doc, {
				ignoreOrigin: isLocalStoreOrigin,
				onProblem: deps.onProblem,
				log: deps.log,
				createHub: (hooks) => {
					const settings = deps.getSettings();
					const cert = settings.lanCertPem && settings.lanTlsKeyPem
						? { certPem: settings.lanCertPem, keyPem: settings.lanTlsKeyPem }
						// Not expected (the identity is made before sync starts); a throwaway certificate keeps the hub usable.
						: generateLanCert();
					const own = fingerprintOfPem(cert.certPem);
					return new LanHub({
						deviceId: settings.lanDeviceId ?? "lan-device",
						deviceName: settings.deviceName || "This device",
						vaultId: settings.vaultId,
						key: settings.lanKey ?? "",
						port: lanPortOf(settings),
						discoveryPort: lanDiscoveryPortOf(settings),
						discoveryEnabled: isLanDiscoveryOn(settings),
						manualPeers: lanManualPeerList(settings),
						cert: { certPem: cert.certPem, keyPem: cert.keyPem, fingerprint: own },
						getPin: (id) => deps.getSettings().lanPins?.[id],
						setPin: (id, fingerprint) => {
							void deps.updateSettings((s) => { s.lanPins = { ...(s.lanPins ?? {}), [id]: fingerprint }; }, "settings:lan-pin");
						},
						onLinkReady: hooks.onLinkReady,
						onStatusChanged: hooks.onStatusChanged,
						log: deps.log,
					});
				},
			});
			transport = current;
			blobStore?.attach(current);
			return current;
		},
		blobStore(_vaultId) {
			if (!blobStore) {
				blobStore = new LanBlobStore(deps.filesFor("blobs"), () => transport);
				if (transport) blobStore.attach(transport);
			}
			return blobStore;
		},
		snapshotBackend(vaultId, getDoc) {
			snapshotBackend ??= new LanSnapshotBackend(deps.filesFor("snapshots"), { vaultId, getDoc });
			return snapshotBackend;
		},
		applyManualPeers() {
			transport?.hub.setManualPeers(lanManualPeerList(deps.getSettings()));
		},
		status(): LanStatusView {
			if (!transport) {
				return { running: false, listening: false, port: null, error: null, discoveryRunning: false, fingerprint: "", linked: [], seen: [], refusals: [] };
			}
			const hub = transport.hub.status();
			return {
				running: true,
				listening: hub.listening,
				port: hub.port,
				error: hub.error,
				discoveryRunning: hub.discoveryRunning,
				fingerprint: hub.fingerprint,
				linked: transport.peerSummaries(),
				seen: hub.devices.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, address: `${d.address}:${d.port}`, online: d.online })),
				refusals: hub.refusals,
			};
		},
	};
}
