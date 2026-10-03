/**
 * Phase 0 P2P spike — pairing flow controller (Milestone B2).
 *
 * The P2P home page's pairing flow (P2pPairingFlow) is DOM-free in its logic:
 * these tests drive it against a fake spike host WITHOUT mounting (no DOM in
 * the test environment) — generate records the code + deep link, join trims
 * and ignores empty input, the deep-link prefill is consumed exactly once,
 * disconnect clears the generated code, and update() is unmount-safe.
 */
import type { SpikeState } from "../../src/p2p/spikeHost";
import type { P2pSpikeHost } from "../../src/p2p/spikeHost";
import { P2pPairingFlow } from "../../src/settings/P2pPairingFlow";
import { suite } from "../harness.ts";

const s = suite("p2p-pairing-flow");

function baseState(phase: SpikeState["phase"]): SpikeState {
	return {
		phase,
		error: null,
		code: null,
		deepLink: null,
		codeCharLength: 0,
		codeByteLength: 0,
		candidates: { byType: { host: 0, srflx: 0, prflx: 0, relay: 0 }, total: 0 },
		gathering: null,
		link: null,
		yjs: null,
		lastRttMs: null,
		iceServers: [],
		lastSeen: null,
	};
}

interface FakeSpike {
	host: P2pSpikeHost;
	calls: string[];
	phase: { value: SpikeState["phase"] };
}

function fakeSpike(): FakeSpike {
	const calls: string[] = [];
	const phase = { value: "idle" as SpikeState["phase"] };
	const host = {
		state: () => baseState(phase.value),
		generate: async () => {
			calls.push("generate");
			phase.value = "awaiting-peer";
			return { code: "YAOS-P2P1:test-vault:test-offer", deepLink: "obsidian://yaos?action=p2p-pair&code=x", gathering: "complete" };
		},
		join: async (code: string) => {
			calls.push(`join:${code}`);
			phase.value = "connecting";
			return { vaultId: "test-vault", candidates: { byType: { host: 0, srflx: 0, prflx: 0, relay: 0 }, total: 0 } };
		},
		close: () => {
			calls.push("close");
			phase.value = "closed";
		},
	} as unknown as P2pSpikeHost;
	return { host, calls, phase };
}

s.section("1: generate records the code and deep link");
{
	const { host, calls } = fakeSpike();
	const flow = new P2pPairingFlow(host);
	s.check(flow.lastGeneratedCode === null && flow.lastGeneratedDeepLink === null, "nothing recorded before generation");
	s.check(flow.state().phase === "idle", "state() is a passthrough to the spike host");

	s.test("generate() records code + deep link and calls the host once", async () => {
		await flow.generate();
		s.check(calls.filter((c) => c === "generate").length === 1, "the host generated exactly once");
		s.check(flow.lastGeneratedCode === "YAOS-P2P1:test-vault:test-offer", "the generated code is recorded");
		s.check(flow.lastGeneratedDeepLink === "obsidian://yaos?action=p2p-pair&code=x", "the matching deep link is recorded");
		s.check(flow.state().phase === "awaiting-peer", "the passthrough state reflects the host phase");
	});
}

s.section("2: join trims input; empty input is a no-op");
{
	s.test("join() trims whitespace before passing the code to the host", async () => {
		const { host, calls } = fakeSpike();
		const flow = new P2pPairingFlow(host);
		await flow.join("  YAOS-P2P1:test-vault:test-offer\n");
		s.check(calls.length === 1 && calls[0] === "join:YAOS-P2P1:test-vault:test-offer", `the host received the trimmed code (${calls.join(", ")})`);
	});

	s.test("join() with blank input does nothing", async () => {
		const { host, calls } = fakeSpike();
		const flow = new P2pPairingFlow(host);
		await flow.join("   \t ");
		s.check(calls.length === 0, `no host call for a blank code (${calls.join(", ") || "none"})`);
	});
}

s.section("3: the deep-link prefill is consumed exactly once");
{
	const { host } = fakeSpike();
	const flow = new P2pPairingFlow(host);
	s.check(flow.consumeJoinPrefill() === null, "no prefill before one arrives");

	flow.prefillJoin("  YAOS-P2P1:test-vault:pre-filled  ");
	const first = flow.consumeJoinPrefill();
	const second = flow.consumeJoinPrefill();
	s.check(first === "YAOS-P2P1:test-vault:pre-filled", `the prefill is consumed, trimmed (${first ?? "null"})`);
	s.check(second === null, "the prefill is consumed exactly once");

	flow.prefillJoin("");
	s.check(flow.consumeJoinPrefill() === null, "a blank prefill is ignored");
}

s.section("4: disconnect clears the generated code");
{
	const { host, calls } = fakeSpike();
	const flow = new P2pPairingFlow(host);

	s.test("disconnect() closes the link and forgets the code", async () => {
		await flow.generate();
		s.check(flow.lastGeneratedCode !== null, "a code exists before disconnect");
		flow.disconnect();
		s.check(calls.includes("close"), "the host link was closed");
		s.check(flow.lastGeneratedCode === null && flow.lastGeneratedDeepLink === null, "code and deep link are cleared");
		s.check(flow.state().phase === "closed", "the host phase is closed");
	});
}

s.section("5: update() is safe without a mount");
{
	const { host } = fakeSpike();
	const flow = new P2pPairingFlow(host);
	s.test("update() without mount() is a no-op (no DOM access)", () => {
		flow.update(); // must not throw — the page timer can fire before/after mount
		s.check(true, "no DOM access before mounting");
	});
	flow.prefillJoin("YAOS-P2P1:test-vault:pending");
	flow.update(); // still unmounted — the prefill must survive for consumption
	s.check(flow.consumeJoinPrefill() === "YAOS-P2P1:test-vault:pending", "an unmounted update() does not swallow the prefill");
}

await s.done();
