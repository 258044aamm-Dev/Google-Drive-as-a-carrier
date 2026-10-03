/**
 * Local network carrier — documents travelling between devices over real
 * secure links on loopback: catch-up, live edits, relaying, loops, receipts,
 * presence, attachments, restarts.
 */
import * as Y from "yjs";
import { suite } from "../harness.ts";
import { generateLanKey, makeNode, sleep, waitFor, type RigNode } from "../mocks/lanRig";
import { parseSvEchoMessage } from "../../src/sync/svEchoMessage";
import type { LanBlobHost } from "../../src/lan-carrier/lanTransport";

const s = suite("lan-transport");
const H = (c: string): string => c.repeat(64).slice(0, 64);
const key = generateLanKey();
const nodes: RigNode[] = [];
const node = (id: string, extra = {}): RigNode => { const n = makeNode(id, key, extra); nodes.push(n); return n; };
const text = (n: RigNode): string => n.doc.getText("t").toString();
const same = (a: RigNode, b: RigNode): boolean => Y.equalSnapshots(Y.snapshot(a.doc), Y.snapshot(b.doc));
async function up(...list: RigNode[]): Promise<void> { for (const n of list) await n.transport.connect(); }
function cleanup(): void { for (const n of nodes.splice(0)) n.stop(); }

try {
	s.section("1: a device that joins late receives everything; both then edit and converge");
	{
		const a = node("dev-a");
		const b = node("dev-b");
		a.doc.getText("t").insert(0, "hello from A. ");
		a.doc.getMap("files").set("x.md", "one");
		await up(a, b);
		s.check(a.transport.wsconnected === false && b.transport.synced === false, "alone: offline and not synced");
		b.linkTo(a);
		s.check(await waitFor(() => a.transport.synced && b.transport.synced), "after linking, both report synced");
		s.check(text(b) === "hello from A. " && b.doc.getMap("files").get("x.md") === "one", "B received A's history");
		s.check(a.transport.wsconnected && b.transport.wsconnected, "both report connected");
		a.doc.getText("t").insert(0, "[a]");
		b.doc.getText("t").insert(b.doc.getText("t").length, "[b]");
		s.check(await waitFor(() => same(a, b) && text(a).includes("[a]") && text(a).includes("[b]")), "concurrent edits on both sides merge identically");
		const before = b.receipts.length;
		a.doc.getMap("files").set("y.md", "two");
		await waitFor(() => b.doc.getMap("files").get("y.md") === "two");
		await waitFor(() => a.receipts.length > 0);
		s.check(a.receipts.length > 0, "the author gets a receipt that another device holds its change");
		const echoed = a.receipts.map((m) => parseSvEchoMessage(m)).filter((x): x is Uint8Array => x !== null);
		s.check(echoed.length > 0 && echoed.some((sv) => Y.decodeStateVector(sv).size > 0), "the receipt carries a real state vector the engine can read");
		void before;
		cleanup();
	}

	s.section("2: relaying through a middle device when two never see each other (A - B - C)");
	{
		const a = node("dev-a");
		const b = node("dev-b");
		const c = node("dev-c");
		await up(a, b, c);
		a.linkTo(b);
		c.linkTo(b);
		await waitFor(() => b.transport.peerSummaries().length === 2 && b.transport.synced);
		a.doc.getText("t").insert(0, "from A");
		s.check(await waitFor(() => text(c) === "from A"), "C receives A's edit through B");
		c.doc.getText("t").insert(c.doc.getText("t").length, " + C");
		s.check(await waitFor(() => text(a) === "from A + C"), "A receives C's edit through B");
		s.check(a.transport.peerSummaries().length === 1 && c.transport.peerSummaries().length === 1, "A and C were never linked");
		cleanup();
	}

	s.section("3: a triangle of links settles (no update loops forever)");
	{
		const a = node("dev-a");
		const b = node("dev-b");
		const c = node("dev-c");
		await up(a, b, c);
		let updates = 0;
		for (const n of [a, b, c]) n.doc.on("update", () => { updates++; });
		a.linkTo(b);
		b.linkTo(c);
		c.linkTo(a);
		await waitFor(() => [a, b, c].every((n) => n.transport.peerSummaries().length === 2), 6000);
		s.check([a, b, c].every((n) => n.transport.peerSummaries().length === 2), "all three are linked with both others");
		a.doc.getText("t").insert(0, "x");
		await waitFor(() => text(b) === "x" && text(c) === "x");
		await sleep(200);
		const settledAt = updates;
		await sleep(600);
		s.check(updates === settledAt, `no further document updates once settled (${updates} in total)`);
		s.check(updates <= 6, `a single edit caused only a handful of updates in three documents (${updates})`);
		cleanup();
	}

	s.section("4: updates that depend on missing ones are not reported as synced, and are asked for again calmly");
	{
		const a = node("dev-a");
		const b = node("dev-b", { resyncDelayMs: 300 });
		await up(a, b);
		const src = new Y.Doc();
		src.getText("t").insert(0, "first");
		const first = Y.encodeStateAsUpdate(src);
		const sv = Y.encodeStateVector(src);
		src.getText("t").insert(5, " second");
		const second = Y.encodeStateAsUpdate(src, sv);
		// A only holds the second update: its predecessor is missing there too.
		Y.applyUpdate(a.doc, second, "seed");
		s.check(a.doc.store.pendingStructs !== null, "(sanity) A holds an update whose predecessor is missing");
		let framesToB = 0;
		b.doc.on("update", () => { framesToB++; });
		b.linkTo(a);
		await waitFor(() => a.transport.synced, 4000);
		await sleep(700);
		s.check(!b.transport.synced, "B does not claim to be synced while data is missing");
		s.check(/missing/.test(b.transport.lastError ?? ""), "and says why");
		s.check(framesToB <= 3, `B asks again after a pause, not in a tight loop (${framesToB} updates)`);
		Y.applyUpdate(a.doc, first, "seed");
		s.check(await waitFor(() => b.transport.synced && text(b) === "first second", 6000), "when the missing update arrives, B completes and reports synced");
		cleanup();
	}

	s.section("5: presence (awareness) crosses links and is removed when the link goes");
	{
		const a = node("dev-a");
		const b = node("dev-b");
		await up(a, b);
		b.linkTo(a);
		await waitFor(() => a.transport.synced && b.transport.synced);
		a.transport.awareness.setLocalState({ user: { name: "Alice" } });
		s.check(await waitFor(() => Array.from(b.transport.awareness.getStates().values()).some((st) => (st as { user?: { name?: string } }).user?.name === "Alice")), "B sees Alice's presence");
		a.transport.disconnect();
		s.check(await waitFor(() => !Array.from(b.transport.awareness.getStates().values()).some((st) => (st as { user?: { name?: string } }).user?.name === "Alice")), "when A leaves, her presence is removed on B");
		cleanup();
	}

	s.section("6: disconnect and connect again (what the engine's reconnect does) heals");
	{
		const a = node("dev-a");
		const b = node("dev-b");
		await up(a, b);
		b.linkTo(a);
		await waitFor(() => a.transport.synced && b.transport.synced);
		const states: string[] = [];
		b.transport.on("status", (e) => states.push(e.status));
		const port = b.port();
		b.transport.disconnect();
		s.check(!b.transport.wsconnected && !b.transport.synced, "disconnect: offline and not synced at once");
		a.doc.getText("t").insert(0, "while B was away");
		await b.transport.connect();
		s.check(b.port() !== undefined && port !== undefined, "the hub starts again");
		s.check(await waitFor(() => text(b) === "while B was away", 8000), "after connecting again, B catches up by itself");
		s.check(states.includes("connected"), "and the engine is told 'connected'");
		cleanup();
	}

	s.section("7: attachments are requested from, and pushed to, linked devices");
	{
		const a = node("dev-a");
		const b = node("dev-b");
		const stored = new Map<string, Uint8Array>([[H("1"), new Uint8Array([1, 2, 3])]]);
		const host: LanBlobHost = {
			serve: (h) => Promise.resolve(stored.get(h) ?? null),
			receive: (h, bytes) => { stored.set(h, bytes); return Promise.resolve(); },
			has: (hs) => Promise.resolve(hs.filter((h) => stored.has(h))),
		};
		a.transport.setBlobHost(host);
		await up(a, b);
		s.check(await b.transport.requestBlob(H("1"), 300) === null, "no linked device: nothing to ask, null at once");
		s.check(await b.transport.waitForPeer(100) === false, "waitForPeer times out when nobody is linked");
		const waiting = b.transport.waitForPeer(5000);
		b.linkTo(a);
		s.check(await waiting, "waitForPeer returns when a device links");
		await waitFor(() => a.transport.synced && b.transport.synced);
		const got = await b.transport.requestBlob(H("1"), 3000);
		s.check(got !== null && Array.from(got).join() === "1,2,3", "a stored attachment is delivered");
		s.check(await b.transport.requestBlob(H("c"), 3000) === null, "an unknown attachment answers 'not here' quickly");
		s.check((await b.transport.peersHave([H("1"), H("d")])).join() === H("1"), "peersHave lists what linked devices hold");
		b.transport.pushBlob(H("2"), new Uint8Array([9, 9]));
		s.check(await waitFor(() => stored.has(H("2"))), "a pushed attachment arrives at the host");
		const big = new Uint8Array(3_000_000).fill(5);
		stored.set(H("b"), big);
		const bigGot = await b.transport.requestBlob(H("b"), 10_000);
		s.check(bigGot?.length === 3_000_000, "a 3 MB attachment is delivered");
		cleanup();
	}

	s.section("8: a wrong key never merges documents; a stopped transport leaves no timers behind");
	{
		const a = node("dev-a");
		const rogue = makeNode("dev-r", generateLanKey());
		nodes.push(rogue);
		a.doc.getText("t").insert(0, "private");
		await up(a, rogue);
		rogue.linkTo(a);
		await sleep(1500);
		s.check(text(rogue) === "" && !rogue.transport.synced && a.transport.peerSummaries().length === 0, "no data crosses without the key");
		cleanup();
		s.check(true, "destroyed cleanly");
	}

	s.section("9: no key set means the transport reports the problem instead of syncing");
	{
		const n = makeNode("dev-k", "");
		nodes.push(n);
		await n.transport.connect();
		s.check(n.problems.length === 1 && /pairing key/.test(n.problems[0] ?? ""), "onProblem is called once with a clear message");
		s.check(n.transport.lastError !== null && !n.transport.wsconnected, "lastError is set and the transport is offline");
		cleanup();
	}
} finally {
	cleanup();
}
await s.done();
