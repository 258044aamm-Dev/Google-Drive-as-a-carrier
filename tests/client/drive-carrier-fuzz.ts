/**
 * Drive carrier: seeded random simulation (permanent suite).
 *
 * 3 or 4 devices share one in-memory Drive and perform random edits, polls, going
 * offline, crashes and restarts (the document survives, the transport does not),
 * injected Drive errors, lost upload responses, clocks that disagree, compaction
 * every few segments, and interleaved Drive calls. After the faults stop every
 * device must hold the same document, and a brand-new device that reads Drive
 * alone must obtain it too. Seeds are fixed, so a failure is reproducible:
 * set FUZZ_ONLY=<name> and FUZZ_SEEDS=<n> to rerun one configuration.
 */
import * as Y from "yjs";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { DriveKeyring } from "../../src/drive-carrier/driveKeyring";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-fuzz");
const VAULT = "v1";

interface Config {
	name: string;
	seeds: number;
	steps: number;
	devices: number;
	encrypted: boolean;
	skew: boolean;
	tiny: boolean;
	concurrent: boolean;
}

const CONFIGS: Config[] = [
	{ name: "default", seeds: 40, steps: 120, devices: 3, encrypted: false, skew: false, tiny: false, concurrent: false },
	{ name: "clocks disagree + compaction every segment", seeds: 40, steps: 120, devices: 3, encrypted: false, skew: true, tiny: true, concurrent: false },
	{ name: "four devices, interleaved calls, clocks disagree", seeds: 30, steps: 120, devices: 4, encrypted: false, skew: true, tiny: true, concurrent: true },
	{ name: "encrypted vault", seeds: 25, steps: 120, devices: 3, encrypted: true, skew: false, tiny: false, concurrent: false },
	{ name: "encrypted, four devices, interleaved, clocks disagree", seeds: 20, steps: 120, devices: 4, encrypted: true, skew: true, tiny: true, concurrent: true },
];

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Dev { name: string; doc: Y.Doc; t: DriveTransport; compact: number }

async function runConfig(cfg: Config, seeds: number): Promise<string[]> {
	const failures: string[] = [];
	for (let seed = 1; seed <= seeds; seed++) {
		let T = 1_700_000_000_000;
		const SK: Record<string, number> = {};
		const rand = rng(seed);
		const pick = <X,>(xs: X[]): X => xs[Math.floor(rand() * xs.length)] as X;
		const drive = new FakeDrive();
		const make = (name: string, doc: Y.Doc, compact: number): Dev => {
			const api = drive.client();
			const keyring = cfg.encrypted ? new DriveKeyring(api, { vaultId: VAULT, passphrase: "pw", kdfIterations: 1000 }) : undefined;
			const t = new DriveTransport(doc, api, { keyring, vaultId: VAULT, deviceId: name, autoTimers: false, now: () => T + (SK[name] ?? 0), compactSegmentCount: compact, reconcileIntervalMs: 120_000, pollIntervalMs: 1000 });
			return { name, doc, t, compact };
		};
		const skews = cfg.skew ? [0, 600_000, -300_000, 0] : [0, 0, 0, 0];
		const names = ["A", "B", "C", "D"].slice(0, cfg.devices);
		const devs: Dev[] = names.map((n, i) => {
			SK[n] = skews[i] ?? 0;
			const doc = new Y.Doc();
			doc.clientID = 1000 + i + seed * 10;
			return make(n, doc, cfg.tiny ? 1 : 2 + Math.floor(rand() * 4));
		});
		if (cfg.concurrent) drive.latencyHook = async () => { const n = Math.floor(rand() * 4); for (let k = 0; k < n; k++) await new Promise<void>((r) => setImmediate(r)); };
		const online = new Map<string, boolean>(devs.map((d) => [d.name, true]));
		for (const d of devs) await d.t.connect();
		let word = 0;
		for (let step = 0; step < cfg.steps; step++) {
			const d = pick(devs);
			const act = rand();
			T += Math.floor(rand() * 20_000);
			try {
				if (act < 0.45) {
					const txt = d.doc.getText("t");
					txt.insert(Math.floor(rand() * (txt.length + 1)), `<${d.name}${word++}>`);
				} else if (act < 0.52) {
					const txt = d.doc.getText("t");
					if (txt.length > 6) txt.delete(Math.floor(rand() * (txt.length - 5)), 1 + Math.floor(rand() * 4));
				} else if (act < 0.60) {
					const m = d.doc.getMap<Y.Text>("notes");
					const key = `n${Math.floor(rand() * 4)}`;
					if (rand() < 0.7) { if (!m.get(key)) { const x = new Y.Text(); x.insert(0, `${d.name}${word++}`); m.set(key, x); } } else m.delete(key);
				} else if (act < 0.85) {
					if (cfg.concurrent) {
						const group = devs.filter((x) => online.get(x.name) && rand() < 0.7);
						await Promise.all(group.map((x) => x.t.syncNow()));
					} else if (online.get(d.name)) await d.t.syncNow();
				} else if (act < 0.89) {
					online.set(d.name, !online.get(d.name));
					if (!online.get(d.name)) d.t.disconnect(); else await d.t.connect();
				} else if (act < 0.93) {
					d.t.destroy();
					const fresh = make(d.name, d.doc, d.compact);
					devs[devs.indexOf(d)] = fresh;
					if (online.get(d.name)) await fresh.t.connect();
				} else if (act < 0.96) {
					drive.failNext(pick(["createFile", "readFile", "listFiles", "deleteFile"] as const), pick([0, 500, 503]), 1 + Math.floor(rand() * 2));
				} else if (act < 0.98) {
					drive.loseResponseNext(1);
				} else {
					drive.clock += 1;
				}
			} catch (err) {
				failures.push(`${cfg.name} seed ${seed}: exception ${String(err)}`);
			}
		}
		drive.offline = false;
		drive.latencyHook = null;
		for (let r = 0; r < 8; r++) {
			for (const d of devs) {
				const cur = devs.find((x) => x.name === d.name) as Dev;
				T += 130_000;
				if (!online.get(cur.name)) { online.set(cur.name, true); await cur.t.connect(); }
				await cur.t.syncNow();
			}
		}
		const texts = devs.map((d) => d.doc.getText("t").toString());
		const maps = devs.map((d) => JSON.stringify(Object.fromEntries(Array.from(d.doc.getMap<Y.Text>("notes").entries()).sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => [k, v.toString()]))));
		if (new Set(texts).size !== 1) failures.push(`${cfg.name} seed ${seed}: devices diverged (text)`);
		if (new Set(maps).size !== 1) failures.push(`${cfg.name} seed ${seed}: devices diverged (map)`);
		const fdoc = new Y.Doc();
		const fresh = make("Z", fdoc, 5);
		await fresh.t.connect();
		await fresh.t.syncNow();
		if (fdoc.getText("t").toString() !== texts[0]) failures.push(`${cfg.name} seed ${seed}: Drive alone does not reproduce the document`);
		fresh.t.destroy();
		for (const d of devs) d.t.destroy();
	}
	return failures;
}

const only = process.env.FUZZ_ONLY;
const seedsOverride = process.env.FUZZ_SEEDS ? Number(process.env.FUZZ_SEEDS) : null;
for (const cfg of CONFIGS) {
	if (only && !cfg.name.includes(only)) continue;
	s.section(`${cfg.name} (${seedsOverride ?? cfg.seeds} seeds x ${cfg.steps} steps, ${cfg.devices} devices)`);
	const failures = await runConfig(cfg, seedsOverride ?? cfg.seeds);
	for (const f of failures.slice(0, 5)) console.log("  ", f);
	s.check(failures.length === 0, `${cfg.name}: every device converged and Drive alone reproduces the document (${failures.length} failing seeds)`);
}
await s.done();
