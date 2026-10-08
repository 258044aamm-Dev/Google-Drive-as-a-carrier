import { DriveError, type DriveApi, type DriveFileInfo } from "./driveApi";
import { ensureFolder, oldestFirst } from "./driveFolders";
import {
	DEFAULT_KDF_ITERATIONS,
	EncryptionError,
	createEncryption,
	parseEncryptionMeta,
	unlockEncryption,
	type DriveSealer,
} from "./driveCrypto";
import { META_NAME } from "./fileFormat";

/** Schema of the Drive layout. A device refuses a vault folder written with another one. */
export const DRIVE_LAYOUT_SCHEMA = 1;

/** A problem that retrying cannot fix (another layout, encryption mismatch, wrong passphrase). */
export class FatalCarrierError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FatalCarrierError";
	}
}

export interface DriveKeyringOptions {
	vaultId: string;
	/** Empty: no encryption. */
	passphrase: string;
	/** Drive folder name. Defaults to `YAOS <vaultId>`. */
	folderName?: string;
	/** Only used when this device creates the vault folder. */
	kdfIterations?: number;
}

/**
 * Owns the vault folder's `meta.json`: checks the layout, and decides and
 * remembers whether the vault is encrypted. Everything that stores data for a
 * vault (sync files, attachments, snapshots) asks the keyring for the sealer,
 * so they all agree and none of them can write plain files into an encrypted
 * vault or the other way round.
 */
export class DriveKeyring {
	private resolvedSealer: DriveSealer | null = null;
	private resolved = false;
	private pending: Promise<DriveSealer | null> | null = null;
	private readonly folderName: string;

	constructor(
		private readonly api: DriveApi,
		private readonly options: DriveKeyringOptions,
	) {
		this.folderName = options.folderName ?? `YAOS ${options.vaultId}`;
	}

	/** The sealer, once `ensureMeta` has succeeded. Null: the vault is not encrypted. */
	get sealer(): DriveSealer | null {
		return this.resolvedSealer;
	}

	/** True once the meta file was checked successfully. */
	get isReady(): boolean {
		return this.resolved;
	}

	/** For stores that may run before the sync transport: find or create the vault folder, then check it. */
	ready(): Promise<DriveSealer | null> {
		this.pending ??= ensureFolder(this.api, this.folderName)
			.then((folderId) => this.ensureMeta(folderId))
			.then(
				() => this.resolvedSealer,
				(err: unknown) => {
					this.pending = null;
					throw err;
				},
			);
		return this.pending;
	}

	async ensureMeta(folderId: string, check: () => void = () => undefined): Promise<void> {
		check();
		if (this.resolved) return;
		const files = await this.api.listFiles(folderId);
		check();
		const metas = oldestFirst(files.filter((f) => f.name === META_NAME));
		const passphrase = this.options.passphrase;
		const first = metas[0];
		if (!first) {
			await this.createMeta(folderId, passphrase, check);
			return;
		}
		await this.readMeta(first, passphrase, check);
	}

	private async createMeta(folderId: string, passphrase: string, check: () => void): Promise<void> {
		check();
		const body: Record<string, unknown> = { app: "yaos-drive", schema: DRIVE_LAYOUT_SCHEMA, vaultId: this.options.vaultId };
		if (!passphrase) {
			await this.api.createFile(folderId, META_NAME, new TextEncoder().encode(JSON.stringify(body)));
			check();
			this.resolved = true;
			return;
		}
		const created = await createEncryption(passphrase, this.options.vaultId, this.options.kdfIterations ?? DEFAULT_KDF_ITERATIONS);
		check();
		body.encryption = created.meta;
		const mine = await this.api.createFile(folderId, META_NAME, new TextEncoder().encode(JSON.stringify(body)));
		check();
		// Two devices may start an encrypted vault at the same moment, each with its own salt.
		// Everyone adopts the oldest meta file; nothing has been written with a key yet.
		const all = oldestFirst((await this.api.listFiles(folderId)).filter((f) => f.name === META_NAME));
		check();
		const chosen = all[0];
		if (!chosen || chosen.id === mine.id) {
			this.resolvedSealer = created.sealer;
			this.resolved = true;
			return;
		}
		await this.api.deleteFile(mine.id).catch(() => undefined);
		check();
		await this.readMeta(chosen, passphrase, check);
	}

	private async readMeta(file: DriveFileInfo, passphrase: string, check: () => void): Promise<void> {
		check();
		const raw = new TextDecoder().decode(await this.api.readFile(file.id));
		check();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
		const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		if (record.schema !== DRIVE_LAYOUT_SCHEMA) {
			throw new FatalCarrierError(
				`This vault folder on Drive uses layout ${String(record.schema)}, but this plugin understands layout ${DRIVE_LAYOUT_SCHEMA}. Update the plugin on all devices.`,
			);
		}
		if (record.encryption === undefined) {
			if (passphrase) {
				throw new FatalCarrierError(
					"This vault folder on Drive is not encrypted, and encryption can only be chosen when a vault is first created. Remove the encryption passphrase, or use a new Vault ID.",
				);
			}
			this.resolved = true;
			return;
		}
		const meta = parseEncryptionMeta(record.encryption);
		if (!meta) throw new FatalCarrierError("This vault folder on Drive has encryption details this plugin cannot read. Update the plugin on all devices.");
		if (!passphrase) {
			throw new FatalCarrierError("This vault is encrypted. Enter its encryption passphrase in the YAOS settings, then reload the plugin.");
		}
		try {
			const sealer = await unlockEncryption(passphrase, this.options.vaultId, meta);
			check();
			this.resolvedSealer = sealer;
		} catch (err) {
			if (err instanceof EncryptionError) throw new FatalCarrierError(`${err.message} Check the passphrase in the YAOS settings, then reload the plugin.`);
			throw err instanceof Error ? err : new DriveError(500, String(err));
		}
		this.resolved = true;
	}
}
