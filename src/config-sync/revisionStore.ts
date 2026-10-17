import * as Y from "yjs";
import { CONFIG_PATHS, ConfigSafetyError, configPath, digest, projectConfig, record, type ConfigPath } from "./policy";

export const CONFIG_NAMESPACE = "yaos.config.preview.v1";
export const MAX_CONFIG_REVISIONS = 128;
export const MAX_CONFIG_HISTORY_BYTES = 512 * 1024;
export type ConfigValues = Partial<Record<ConfigPath, string>>;
interface Revision {
	version: 1;
	vault: string;
	kind: "seed" | "put";
	epoch: string;
	author: string;
	parents: string[];
	rank: number;
	values: ConfigValues;
}
export interface ConfigView {
	sequence: number;
	epoch: string | null;
	values: ConfigValues;
	frontiers: Partial<Record<ConfigPath, string[]>>;
	revisions: number;
	retainedAlternatives: number;
	bytes: number;
	entries: ReadonlyMap<string, Revision>;
}
const ID = /^[0-9a-f]{64}$/;
const AUTHOR = /^[a-zA-Z0-9_-]{8,64}$/;

function canonicalValues(values: ConfigValues): ConfigValues {
	const out: ConfigValues = {};
	for (const path of CONFIG_PATHS) {
		const text = values[path];
		if (text !== undefined) out[path] = projectConfig(path, text);
	}
	return out;
}

function decode(raw: string, vault: string): Revision {
	let v: unknown;
	try { v = JSON.parse(raw); } catch { throw new ConfigSafetyError("invalid-config-revision"); }
	if (!record(v) || v.version !== 1 || v.vault !== vault || (v.kind !== "seed" && v.kind !== "put")
		|| typeof v.epoch !== "string" || typeof v.author !== "string" || !AUTHOR.test(v.author)
		|| !Array.isArray(v.parents) || v.parents.length > MAX_CONFIG_REVISIONS
		|| !v.parents.every((p: unknown) => typeof p === "string" && ID.test(p))
		|| new Set(v.parents).size !== v.parents.length
		|| typeof v.rank !== "number" || !Number.isSafeInteger(v.rank) || v.rank < 0 || v.rank > MAX_CONFIG_REVISIONS
		|| !record(v.values) || Object.keys(v.values).some((p) => !configPath(p))
		|| !Object.values(v.values).every((text) => typeof text === "string")) throw new ConfigSafetyError("unsupported-config-revision");
	const values = canonicalValues(v.values as ConfigValues);
	if (v.kind === "seed" ? (v.epoch !== "" || v.parents.length !== 0 || v.rank !== 0)
		: (!ID.test(v.epoch) || v.parents.length === 0 || Object.keys(values).length !== 1 || v.rank === 0)) {
		throw new ConfigSafetyError("invalid-config-causality");
	}
	const result: Revision = { version: 1, vault, kind: v.kind, epoch: v.epoch, author: v.author, parents: v.parents.filter((parent: unknown): parent is string => typeof parent === "string"), rank: v.rank, values };
	// Prevent unreviewed fields, alternative encodings and noncanonical payloads
	// from being accepted just because their outer JSON has a valid hash.
	if (JSON.stringify(result) !== raw) throw new ConfigSafetyError("noncanonical-config-revision");
	return result;
}

/**
 * Bounded, immutable, content-addressed history in a separate Yjs namespace.
 * No writes to note/attachment maps; no history or tombstone pruning in preview.
 * Carrier encryption/authentication still applies. Hashes are not signatures.
 */
export class ConfigRevisionStore {
	private readonly log: Y.Map<unknown>;
	private sequence = 0;
	private disposed = false;
	private readonly changed = (): void => { this.sequence++; };

	constructor(private readonly doc: Y.Doc, private readonly vault: string, private readonly author: string) {
		if (!vault || vault.length > 200 || !AUTHOR.test(author)) throw new ConfigSafetyError("invalid-config-identity");
		this.log = doc.getMap(CONFIG_NAMESPACE);
		this.log.observe(this.changed);
	}

	destroy(): void { this.disposed = true; this.log.unobserve(this.changed); }

	private check(sequence: number, guard: () => void): void {
		guard();
		if (this.disposed) throw new ConfigSafetyError("config-session-ended");
		if (sequence !== this.sequence) throw new ConfigSafetyError("config-changed-rescan");
	}

	async view(guard: () => void = () => undefined): Promise<ConfigView> {
		const sequence = this.sequence;
		this.check(sequence, guard);
		if (this.log.size > MAX_CONFIG_REVISIONS) throw new ConfigSafetyError("config-history-limit");
		const snapshot = [...this.log.entries()];
		const entries = new Map<string, Revision>();
		let bytes = 0;
		for (const [id, raw] of snapshot) {
			if (!ID.test(id) || typeof raw !== "string" || raw.length > MAX_CONFIG_HISTORY_BYTES) throw new ConfigSafetyError("invalid-config-envelope");
			bytes += new TextEncoder().encode(raw).length;
			if (bytes > MAX_CONFIG_HISTORY_BYTES) throw new ConfigSafetyError("config-history-limit");
			if (await digest(raw) !== id) throw new ConfigSafetyError("config-hash-mismatch");
			this.check(sequence, guard);
			entries.set(id, decode(raw, this.vault));
		}
		const seeds = [...entries].filter(([, r]) => r.kind === "seed").map(([id]) => id).sort();
		for (const r of entries.values()) {
			if (r.kind === "seed") continue;
			if (entries.get(r.epoch)?.kind !== "seed") throw new ConfigSafetyError("config-parent-pending");
			let rank = 0;
			const path = Object.keys(r.values)[0];
			for (const parent of r.parents) {
				const p = entries.get(parent);
				if (!p) throw new ConfigSafetyError("config-parent-pending");
				if (p.kind === "seed" ? parent !== r.epoch : (p.epoch !== r.epoch || Object.keys(p.values)[0] !== path)) throw new ConfigSafetyError("invalid-config-parent");
				rank = Math.max(rank, p.rank);
			}
			if (r.rank !== rank + 1) throw new ConfigSafetyError("invalid-config-rank");
		}
		const epoch = seeds[0] ?? null;
		const values: ConfigValues = epoch ? { ...entries.get(epoch)!.values } : {};
		const frontiers: Partial<Record<ConfigPath, string[]>> = {};
		let winners = epoch ? 1 : 0;
		for (const path of CONFIG_PATHS) {
			const candidates = [...entries].filter(([, r]) => r.kind === "put" && r.epoch === epoch && r.values[path] !== undefined);
			const parents = new Set(candidates.flatMap(([, r]) => r.parents));
			const tips = candidates.filter(([id]) => !parents.has(id));
			frontiers[path] = tips.length ? tips.map(([id]) => id).sort() : epoch ? [epoch] : [];
			tips.sort(([a, x], [b, y]) => x.rank - y.rank || (x.author < y.author ? -1 : x.author > y.author ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0));
			const winner = tips[tips.length - 1];
			if (winner) { values[path] = winner[1].values[path]; winners++; }
		}
		this.check(sequence, guard);
		return { sequence, epoch, values, frontiers, revisions: entries.size, retainedAlternatives: Math.max(0, entries.size - winners), bytes, entries };
	}

	async seed(values: ConfigValues, guard: () => void = () => undefined): Promise<void> {
		const view = await this.view(guard);
		if (view.epoch) return;
		if (Object.keys(canonicalValues(values)).length === 0) throw new ConfigSafetyError("config-empty-seed-blocked");
		await this.append(view, { version: 1, vault: this.vault, kind: "seed", epoch: "", author: this.author, parents: [], rank: 0, values: canonicalValues(values) }, guard);
	}

	async publish(path: ConfigPath, text: string, guard: () => void = () => undefined): Promise<void> {
		if (!configPath(path)) throw new ConfigSafetyError("config-path-blocked");
		const view = await this.view(guard);
		if (!view.epoch) throw new ConfigSafetyError("config-baseline-pending");
		const canonical = projectConfig(path, text);
		if (view.values[path] === canonical) return;
		const parents = view.frontiers[path] ?? [view.epoch];
		const rank = 1 + Math.max(...parents.map((id) => view.entries.get(id)!.rank));
		await this.append(view, { version: 1, vault: this.vault, kind: "put", epoch: view.epoch, author: this.author, parents, rank, values: { [path]: canonical } }, guard);
	}

	private async append(view: ConfigView, revision: Revision, guard: () => void): Promise<void> {
		const raw = JSON.stringify(revision);
		if (view.revisions >= MAX_CONFIG_REVISIONS || view.bytes + new TextEncoder().encode(raw).length > MAX_CONFIG_HISTORY_BYTES) throw new ConfigSafetyError("config-history-limit");
		const id = await digest(raw);
		this.check(view.sequence, guard);
		this.doc.transact(() => { this.log.set(id, raw); }, this);
	}
}
