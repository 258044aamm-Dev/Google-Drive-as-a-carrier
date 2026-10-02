import type * as Y from "yjs";
import type { VaultSyncSettings } from "../settings";
import type { TraceHttpContext } from "../observability/traceContext";
import {
	downloadSnapshot,
	listSnapshots,
	requestDailySnapshot,
	requestPrune,
	requestSnapshotNow,
	type SnapshotIndex,
	type SnapshotResult,
} from "../sync/snapshotClient";

/**
 * Where restore points live. The Cloudflare Worker (R2) is the default; a
 * carrier without a server (Google Drive) supplies its own.
 */
export interface SnapshotBackend {
	/** Take today's snapshot unless one already exists. */
	daily(device?: string): Promise<SnapshotResult>;
	/** Take a snapshot now. */
	now(device?: string): Promise<SnapshotResult>;
	/** Newest first. */
	list(): Promise<SnapshotIndex[]>;
	prune(): Promise<{ kept: number; pruned: number; failed: number }>;
	/** The snapshot's content as a standalone, unconnected Y.Doc. */
	download(snapshot: SnapshotIndex): Promise<Y.Doc>;
}

/** The existing Worker-based behaviour, unchanged: each call goes to the same client function as before. */
export function createServerSnapshotBackend(
	getSettings: () => VaultSyncSettings,
	getTrace: () => TraceHttpContext | undefined,
): SnapshotBackend {
	return {
		daily: (device) => requestDailySnapshot(getSettings(), device, getTrace()),
		now: (device) => requestSnapshotNow(getSettings(), device, getTrace()),
		list: () => listSnapshots(getSettings(), getTrace()),
		prune: () => requestPrune(getSettings(), getTrace()),
		download: (snapshot) => downloadSnapshot(getSettings(), snapshot, getTrace()),
	};
}
