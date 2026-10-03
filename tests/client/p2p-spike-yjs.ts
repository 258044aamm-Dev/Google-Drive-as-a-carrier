/**
 * Phase 0 spike — Yjs sync protocol over an in-memory wire (no WebRTC).
 *
 * Proves the handshake and convergence the device sessions will measure:
 * empty↔empty, pre-attach state transfer, both directions, interleaved
 * concurrent edits, and a late joiner receiving the full state (the
 * re-pairing leg of T0.4 offline-resume).
 */
import { SpikeYjs } from "../../src/p2p/spikeYjs";
import { suite } from "../harness.ts";

const s = suite("p2p-spike-yjs");

/** One direction of an in-memory channel: buffers frames, drains on demand. */
class Wire {
	private inbound: Uint8Array[] = [];
	constructor(private readonly onReceive: (bytes: Uint8Array) => void) {}
	get pendingCount(): number {
		return this.inbound.length;
	}
	send(bytes: Uint8Array): void {
		this.inbound.push(bytes);
	}
	drainAll(): void {
		while (this.inbound.length > 0) {
			const next = this.inbound.shift();
			if (next) this.onReceive(next);
		}
	}
}

interface Pair {
	a: SpikeYjs;
	b: SpikeYjs;
	wires: [Wire, Wire];
	detachA: () => void;
	detachB: () => void;
}

function connect(a: SpikeYjs, b: SpikeYjs): Pair {
	const aToB = new Wire((bytes) => b.onMessage(bytes));
	const bToA = new Wire((bytes) => a.onMessage(bytes));
	const detachA = a.attach((bytes) => aToB.send(bytes));
	const detachB = b.attach((bytes) => bToA.send(bytes));
	return { a, b, wires: [aToB, bToA], detachA, detachB };
}

/** Drain both directions to a fixpoint (handshake + replies settle). */
async function settle(wires: Wire[]): Promise<void> {
	let guard = 0;
	for (;;) {
		let pending = 0;
		for (const w of wires) pending += w.pendingCount;
		if (pending === 0) return;
		if (guard++ > 100) throw new Error("settle did not converge");
		for (const w of wires) w.drainAll();
		await new Promise((r) => setTimeout(r, 0));
	}
}

s.section("1: two empty documents converge");
{
	const p = connect(new SpikeYjs(), new SpikeYjs());
	await settle(p.wires);
	s.check(p.a.isSynced && p.b.isSynced, "both report synced");
	s.check(p.a.text.toString() === "" && p.b.text.toString() === "", "both stay empty");
	p.a.doc.destroy();
	p.b.doc.destroy();
}

s.section("2: state existing before the handshake is transferred");
{
	const a = new SpikeYjs();
	a.edit("born before pairing");
	const p = connect(a, new SpikeYjs());
	await settle(p.wires);
	s.check(p.b.text.toString() === "born before pairing", "late joiner receives pre-pairing state");
	s.check(p.a.isSynced && p.b.isSynced, "both report synced");
	p.a.doc.destroy();
	p.b.doc.destroy();
}

s.section("3: edits flow in both directions");
{
	const p = connect(new SpikeYjs(), new SpikeYjs());
	await settle(p.wires);
	p.a.edit("alpha");
	await settle(p.wires);
	s.check(p.b.text.toString() === "alpha", "A → B");
	p.b.edit("beta");
	await settle(p.wires);
	s.check(p.a.text.toString() === "beta", "B → A");
	p.a.doc.destroy();
	p.b.doc.destroy();
}

s.section("4: interleaved concurrent edits converge");
{
	const p = connect(new SpikeYjs(), new SpikeYjs());
	await settle(p.wires);
	p.a.edit("A1");
	p.b.edit("B1");
	p.a.edit("A2");
	p.b.edit("B2");
	await settle(p.wires);
	// Concurrent full-text replacements are CRDT merges, not last-write-wins:
	// the exact interleaving is Yjs's to decide. The spike property is that
	// both peers converge on the SAME text.
	s.check(p.a.text.toString() === p.b.text.toString(), "both peers converge on identical text");
	s.check(p.a.text.length > 0, "merged text is non-empty");
	s.check(p.a.isSynced && p.b.isSynced, "both report synced");
	p.a.doc.destroy();
	p.b.doc.destroy();
}

s.section("5: re-pairing carries the full state to a fresh peer");
{
	// Session 1: A and B converge on content X.
	const a = new SpikeYjs();
	const b = new SpikeYjs();
	const first = connect(a, b);
	await settle(first.wires);
	a.edit("session-1 content");
	await settle(first.wires);
	const x = a.text.toString();

	// B leaves; A re-pairs with a brand-new device C on a fresh wire.
	first.detachA();
	first.detachB();
	b.doc.destroy();
	const c = new SpikeYjs();
	const aToC = new Wire((bytes) => c.onMessage(bytes));
	const cToA = new Wire((bytes) => a.onMessage(bytes));
	a.attach((bytes) => aToC.send(bytes)); // re-attach replaces the old sink
	c.attach((bytes) => cToA.send(bytes));
	await settle([aToC, cToA]);

	s.check(c.text.toString() === x, "fresh peer receives the carried state");
	s.check(c.text.toString() === "session-1 content", "state content is intact");
	s.check(a.isSynced && c.isSynced, "both report synced");
	a.doc.destroy();
	c.doc.destroy();
}

await s.done();
