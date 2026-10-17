import { Notice, type Plugin } from "obsidian";
import type { ConnectionController } from "./runtime/connectionController";
import type { SnapshotService } from "./snapshots/snapshotService";
import type { ReconcileMode, VaultSync } from "./sync/vaultSync";

export interface CommandsRuntimeHost {
	getVaultSync(): VaultSync | null;
	getConnectionController(): ConnectionController | null;
	getSnapshotService(): SnapshotService | null;
	getUntrackedFileCount(): number;
	runReconciliation(mode: ReconcileMode): Promise<void>;
	runSchemaMigrationToV2(): void;
	importUntrackedFiles(): Promise<void>;
	clearLocalServerReceiptState(): Promise<"cleared_persistent" | "cleared_memory_only" | "failed" | undefined>;
	resetLocalCache(): void;
	nuclearReset(): void;
	/** True when the Google Drive carrier is chosen; only changes command names. Absent means Cloudflare. */
	isDriveCarrier?(): boolean;
	isLanCarrier?(): boolean;
}

/**
 * Palette names that mention "server" are only right for the Cloudflare
 * carrier. With Google Drive chosen they say what actually happens.
 */
const DRIVE_COMMAND_NAMES: Readonly<Record<string, string>> = {
	reconnect: "Retry syncing with Google Drive",
	"clear-local-server-receipt-state": "Clear local save-confirmation state",
	"reset-cache": "Reset local cache (re-sync from Google Drive)",
};

const LAN_COMMAND_NAMES: Readonly<Record<string, string>> = {
	reconnect: "Look for my other devices again",
	"clear-local-server-receipt-state": "Clear local save-confirmation state",
	"reset-cache": "Reset local cache (re-sync from linked devices)",
};

export function registerCommands(
	registrar: Pick<Plugin, "addCommand">,
	host: CommandsRuntimeHost,
): void {
	const driveMode = host.isDriveCarrier?.() === true;
	const lanMode = host.isLanCarrier?.() === true;
	const nameFor = (id: string, name: string): string =>
		driveMode ? DRIVE_COMMAND_NAMES[id] ?? name : lanMode ? LAN_COMMAND_NAMES[id] ?? name : name;
	const add = (command: Parameters<Pick<Plugin, "addCommand">["addCommand"]>[0]): void => {
		registrar.addCommand({ ...command, name: nameFor(command.id, command.name) });
	};

	add({
		id: "reconnect",
		name: "Reconnect to sync server",
		callback: () => {
			if (host.getVaultSync()) {
				host.getConnectionController()?.reconnect("manual-command");
				new Notice("Reconnecting...");
			}
		},
	});

	add({
		id: "force-reconcile",
		name: "Force reconcile vault with sync state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) return;
			const mode = vaultSync.getSafeReconcileMode();
			void host.runReconciliation(mode);
		},
	});

	add({
		id: "migrate-schema-v2",
		name: "Migrate sync schema to v2",
		callback: () => {
			host.runSchemaMigrationToV2();
		},
	});

	add({
		id: "import-untracked",
		name: "Import untracked files now",
		callback: () => {
			if (!host.getVaultSync()) {
				new Notice("Sync not initialized");
				return;
			}
			const count = host.getUntrackedFileCount();
			if (count === 0) {
				new Notice("No untracked files to import.");
				return;
			}
			void host.importUntrackedFiles().then(() => {
				new Notice(`Imported ${count} untracked file(s).`);
			});
		},
	});

	add({
		id: "clear-local-server-receipt-state",
		name: "Clear local server-receipt state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) {
				new Notice("Sync not initialized");
				return;
			}
			void host.clearLocalServerReceiptState().then(
				(result) => new Notice(
					result === "cleared_persistent"
						? "Local server-receipt state cleared."
						: result === "cleared_memory_only"
							? "Local server-receipt state cleared for this session. Persistent receipt store is unavailable."
							: "Failed to clear local server-receipt state. Check console.",
					result === "cleared_persistent" ? 4000 : 7000,
				),
				() => new Notice("Failed to clear local server-receipt state. Check console.", 5000),
			);
		},
	});

	add({
		id: "reset-cache",
		name: "Reset local cache (re-sync from server)",
		callback: () => {
			host.resetLocalCache();
		},
	});


	add({
		id: "snapshot-now",
		name: "Take snapshot now",
		callback: async () => {
			await host.getSnapshotService()?.takeSnapshotNow();
		},
	});

	add({
		id: "snapshot-list",
		name: "Browse and restore snapshots",
		callback: async () => {
			await host.getSnapshotService()?.showSnapshotList();
		},
	});

	add({
		id: "snapshot-prune",
		name: "Cleanup old snapshots (apply retention policy)",
		callback: async () => {
			await host.getSnapshotService()?.pruneSnapshots();
		},
	});

	add({
		id: "nuclear-reset",
		name: "Nuclear reset (wipe sync state and reseed from disk)",
		callback: () => {
			host.nuclearReset();
		},
	});
}
