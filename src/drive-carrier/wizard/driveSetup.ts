import { DriveError, type DriveApi } from "../driveApi";
import { ensureFolder, oldestFirst } from "../driveFolders";
import { DriveKeyring, DRIVE_LAYOUT_SCHEMA } from "../driveKeyring";
import { EncryptionError, parseEncryptionMeta, unlockEncryption } from "../driveCrypto";
import { META_NAME } from "../fileFormat";
import { driveFolderLabel } from "../carrierSettings";

/**
 * The two things the wizard does on Drive: create a vault (after proving that
 * writing works), and check an existing vault before joining it.
 */

export type CheckStatus = "pending" | "running" | "done" | "failed";

export interface CheckStep {
	id: "folder" | "write" | "read" | "cleanup" | "vault";
	label: string;
	status: CheckStatus;
}

export const TEST_FILE_NAME = "yaos-setup-check.tmp";

export function createChecklist(vaultId: string): CheckStep[] {
	return [
		{ id: "folder", label: `Create the folder "${driveFolderLabel(vaultId)}" in your Google Drive`, status: "pending" },
		{ id: "write", label: "Save a small test file", status: "pending" },
		{ id: "read", label: "Read it back", status: "pending" },
		{ id: "cleanup", label: "Remove the test file", status: "pending" },
		{ id: "vault", label: "Set up the vault", status: "pending" },
	];
}

export interface CreateVaultOptions {
	vaultId: string;
	/** Empty: not encrypted. */
	passphrase: string;
	kdfIterations?: number;
	onStep?: (steps: CheckStep[]) => void;
}

/**
 * Creates the vault folder and its `meta.json`. Proves that Drive accepts a
 * write and a read first, so a wrong Google setup fails here, with a clear
 * message, instead of later in the background.
 */
export async function createVault(api: DriveApi, options: CreateVaultOptions): Promise<CheckStep[]> {
	const steps = createChecklist(options.vaultId);
	const publish = (): void => options.onStep?.(steps.map((s) => ({ ...s })));
	const run = async <T>(id: CheckStep["id"], work: () => Promise<T>): Promise<T> => {
		const step = steps.find((s) => s.id === id);
		if (!step) throw new Error(`unknown step ${id}`);
		step.status = "running";
		publish();
		try {
			const result = await work();
			step.status = "done";
			publish();
			return result;
		} catch (err) {
			step.status = "failed";
			publish();
			throw err;
		}
	};

	const folderId = await run("folder", () => ensureFolder(api, driveFolderLabel(options.vaultId)));
	const marker = new TextEncoder().encode(`yaos setup check ${options.vaultId}`);
	const written = await run("write", () => api.createFile(folderId, TEST_FILE_NAME, marker));
	await run("read", async () => {
		const back = await api.readFile(written.id);
		if (back.length !== marker.length || back.some((byte, i) => byte !== marker[i])) {
			throw new DriveError(502, "Google Drive returned different data than was saved.");
		}
	});
	await run("cleanup", () => api.deleteFile(written.id));
	await run("vault", async () => {
		const keyring = new DriveKeyring(api, {
			vaultId: options.vaultId,
			passphrase: options.passphrase,
			kdfIterations: options.kdfIterations,
		});
		await keyring.ensureMeta(folderId);
	});
	return steps;
}

export type JoinCheck =
	| { status: "ok"; encrypted: boolean }
	| { status: "not-found" }
	| { status: "needs-passphrase" }
	| { status: "wrong-passphrase" }
	| { status: "not-encrypted" }
	| { status: "other-layout"; found: string };

/**
 * Looks at an existing vault without changing anything: is the folder there
 * (for this Google client), what layout is it, and does the passphrase fit.
 */
export async function checkVaultForJoin(api: DriveApi, vaultId: string, passphrase: string): Promise<JoinCheck> {
	const folders = await api.findFolders(driveFolderLabel(vaultId));
	if (folders.length === 0) return { status: "not-found" };
	const sorted = [...folders].sort((a, b) => a.createdTime - b.createdTime || (a.id < b.id ? -1 : 1));
	const folder = sorted[0];
	if (!folder) return { status: "not-found" };
	const meta = oldestFirst((await api.listFiles(folder.id)).filter((f) => f.name === META_NAME))[0];
	if (!meta) return { status: "not-found" };
	let record: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(await api.readFile(meta.id)));
		if (typeof parsed === "object" && parsed !== null) record = parsed as Record<string, unknown>;
	} catch {
		// An unreadable meta file is reported as another layout below.
	}
	if (record.schema !== DRIVE_LAYOUT_SCHEMA) return { status: "other-layout", found: String(record.schema) };
	if (record.encryption === undefined) {
		return passphrase ? { status: "not-encrypted" } : { status: "ok", encrypted: false };
	}
	const encryption = parseEncryptionMeta(record.encryption);
	if (!encryption) return { status: "other-layout", found: "encryption" };
	if (!passphrase) return { status: "needs-passphrase" };
	try {
		await unlockEncryption(passphrase, vaultId, encryption);
	} catch (err) {
		if (err instanceof EncryptionError) return { status: "wrong-passphrase" };
		throw err;
	}
	return { status: "ok", encrypted: true };
}
