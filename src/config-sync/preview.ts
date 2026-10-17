import type * as Y from "yjs";
import { randomId } from "../utils/randomId";
import { CONFIG_PATHS, MAX_CONFIG_BYTES, ConfigSafetyError, configRoot, digest, projectConfig, record, type ConfigPath } from "./policy";
import { ConfigRevisionStore, type ConfigValues } from "./revisionStore";

export interface ConfigPreviewCheckpoint {
	version: 1;
	vault: string;
	root: string;
	hashes: Partial<Record<ConfigPath, string>>;
}
export interface ConfigPreviewHost {
	doc: Y.Doc;
	vault: string;
	root: string;
	/** Includes local persistence, carrier catch-up and current vault/session checks. */
	ready(): boolean;
	/** Deliberately no write, remove, rename or plugin-activation API. */
	stat(path: string): Promise<{ type: string; size: number } | null>;
	read(path: string): Promise<string>;
	checkpoint: unknown;
	saveCheckpoint(checkpoint: ConfigPreviewCheckpoint): Promise<void>;
	autoTimers?: boolean;
	timeoutMs?: number;
}

function checkpointHashes(value: unknown, vault: string, root: string): ConfigPreviewCheckpoint["hashes"] | null {
	if (!record(value) || value.version !== 1 || value.vault !== vault || value.root !== root || !record(value.hashes)) return null;
	const hashes: ConfigPreviewCheckpoint["hashes"] = {};
	for (const path of CONFIG_PATHS) {
		const hash = value.hashes[path];
		if (hash !== undefined && (typeof hash !== "string" || (hash !== "missing" && !/^[0-9a-f]{64}$/.test(hash)))) return null;
		if (typeof hash === "string") hashes[path] = hash;
	}
	return hashes;
}

/**
 * Safety-gated initial delivery: automatically exchange reviewed projections,
 * retain competing revisions, and stage the deterministic desired state in the
 * local Yjs replica. NEVER modify live config files or activate on restart.
 * Runtime activation, arbitrary packages and deletion remain explicit gates.
 */
export class ConfigSyncPreview {
	private readonly store: ConfigRevisionStore;
	private readonly root: string;
	private observed: ConfigPreviewCheckpoint["hashes"] | null;
	private disposed = false;
	private timer: number | null = null;
	private active: Promise<void> | null = null;
	private cancel: (() => void) | null = null;
	private failures = 0;
	private currentStatus = "Waiting for local persistence and carrier catch-up. No configuration is applied.";

	constructor(private readonly host: ConfigPreviewHost) {
		this.root = configRoot(host.root);
		this.store = new ConfigRevisionStore(host.doc, host.vault, randomId(24));
		this.observed = checkpointHashes(host.checkpoint, host.vault, this.root);
	}

	get status(): string { return this.currentStatus; }

	start(): void {
		if (this.disposed || this.timer !== null || this.active) return;
		void this.tick();
	}

	/** One bounded operation at a time; repeated callers share it. */
	tick(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.active) return this.active;
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		this.active = this.cycle().finally(() => {
			this.active = null;
			if (!this.disposed && this.host.autoTimers !== false && this.failures < 3) {
				this.timer = window.setTimeout(() => { this.timer = null; void this.tick(); }, 30_000 * Math.pow(2, this.failures));
			}
		});
		return this.active;
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel?.();
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.store.destroy();
	}

	private async cycle(): Promise<void> {
		if (this.failures >= 3) return;
		if (!this.host.ready()) {
			this.currentStatus = "Waiting for local persistence and carrier catch-up. No configuration is applied.";
			return;
		}
		let stopped = false;
		let timedOut = false;
		let signal = (): void => undefined;
		const ended = new Promise<void>((resolve) => { signal = resolve; });
		const guard = (): void => {
			if (stopped || this.disposed) throw new ConfigSafetyError(timedOut ? "config-operation-timeout" : "config-session-ended");
			if (!this.host.ready()) throw new ConfigSafetyError("config-not-ready");
		};
		this.cancel = () => { stopped = true; signal(); };
		const ms = this.host.timeoutMs ?? 5000;
		const timeout = window.setTimeout(() => { timedOut = true; this.cancel?.(); }, Number.isFinite(ms) && ms > 0 ? ms : 5000);
		const wait = async <T>(work: () => Promise<T>): Promise<T> => {
			guard();
			const value = await Promise.race([work(), ended.then((): never => { throw new ConfigSafetyError(timedOut ? "config-operation-timeout" : "config-session-ended"); })]);
			guard();
			return value;
		};
		try {
			const work = async (): Promise<void> => {
				let view = await wait(() => this.store.view(guard));
				guard();
				const values: ConfigValues = {};
				const hashes: ConfigPreviewCheckpoint["hashes"] = {};
				let missing = 0;
				for (const path of CONFIG_PATHS) {
					const fullPath = `${this.root}/${path}`;
					const stat = await wait(() => this.host.stat(fullPath));
					guard();
					if (!stat) { hashes[path] = "missing"; missing++; continue; }
					if (stat.type !== "file" || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_CONFIG_BYTES) throw new ConfigSafetyError("config-file-unavailable-or-too-large");
					const raw = await wait(() => this.host.read(fullPath));
					guard();
					const first = projectConfig(path, raw);
					const again = await wait(() => this.host.read(fullPath));
					guard();
					if (first !== projectConfig(path, again)) throw new ConfigSafetyError("config-file-changing-rescan");
					values[path] = first;
					hashes[path] = await wait(() => digest(first));
					guard();
				}
				if (!view.epoch) {
					// No empty-device seed. Missing files never publish deletions.
					if (Object.keys(values).length === 0) {
						this.currentStatus = "No eligible configuration found; waiting for a populated baseline. Nothing is applied.";
						return;
					}
					await wait(() => this.store.seed(values, guard));
					guard();
				} else if (this.observed) {
					for (const path of CONFIG_PATHS) {
						const value = values[path];
						if (value !== undefined && hashes[path] !== this.observed[path]) {
							await wait(() => this.store.publish(path, value, guard));
							guard();
						}
					}
				}
				// A joiner's first scan adopts the shared desired state without
				// replacing or importing its existing live configuration.
				if (JSON.stringify(hashes) !== JSON.stringify(this.observed)) {
					await wait(() => this.host.saveCheckpoint({ version: 1, vault: this.host.vault, root: this.root, hashes }));
					guard();
					this.observed = hashes;
				}
				view = await wait(() => this.store.view(guard));
				guard();
				this.failures = 0;
				this.currentStatus = `${Object.keys(view.values).length} reviewed configuration projections staged; ${view.revisions} retained revisions (${view.retainedAlternatives} historical or alternative). ${missing} source files absent; no deletions sent. Live application, including after restart, is safety-blocked in this preview.`;
			};
			await wait(work);
		} catch (error: unknown) {
			if (this.disposed) return;
			const code = error instanceof ConfigSafetyError ? error.code : "config-local-storage-error";
			const rescan = ["config-changed-rescan", "config-file-changing-rescan", "config-not-ready"].includes(code);
			if (!rescan) this.failures++;
			this.currentStatus = `Configuration preview pending: ${code}. Live files are unchanged.${this.failures >= 3 ? " Paused after three failures; switch the preview off and on to retry." : " Retrying without blocking note sync."}`;
		} finally {
			window.clearTimeout(timeout);
			stopped = true;
			signal();
			this.cancel = null;
		}
	}
}
