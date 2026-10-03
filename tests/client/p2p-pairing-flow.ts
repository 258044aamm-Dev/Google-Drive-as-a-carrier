/**
 * Phase 0 P2P spike — pairing flow controller (Milestone B3 wizard).
 *
 * The P2P home page's pairing wizard (P2pPairingFlow) is DOM-free in its
 * logic: these tests drive it against a fake spike host WITHOUT mounting
 * (no DOM in the test environment) — generate records the code + deep
 * link, join trims and ignores empty input, the deep-link prefill is
 * consumed exactly once AND switches the wizard to the join step,
 * disconnect clears the generated code, update() is unmount-safe, and the
 * pure p2pWizardView mapping pins every visibility/enabled decision
 * (notably: Disconnect only while connected — the drive.15 bug).
 */
import type { P2pSpikeHost, SpikeState } from "../../src/p2p/spikeHost";
import { P2pPairingFlow, p2pWizardView } from "../../src/settings/P2pPairingFlow";
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

s.section("1: pure view model — visibility and enabled decisions");
{
	const idle = p2pWizardView({ phase: "idle", role: "create", code: "", qrRendered: false, joinValue: "" });
	s.check(idle.role === "create", "default role is create");
	s.check(!idle.showDisconnect, "Disconnect hidden when idle (the drive.15 bug)");
	s.check(!idle.showCodePanel, "no code panel before generation");
	s.check(!idle.showQr, "no QR before generation");
	s.check(!idle.copyEnabled, "Copy disabled before a code exists");
	s.check(!idle.joinEnabled, "Join disabled with an empty field");
	s.check(!idle.showGenerateHint, "no regenerate hint while unlinked");

	const linked = p2pWizardView({ phase: "connected", role: "create", code: "", qrRendered: false, joinValue: "" });
	s.check(linked.showDisconnect, "Disconnect shown only while connected");
	s.check(linked.showGenerateHint, "regenerate hint shown while connected");

	const gen = p2pWizardView({ phase: "awaiting-peer", role: "create", code: "YAOS-P2P1:x", qrRendered: false, joinValue: "" });
	s.check(gen.showCodePanel && gen.copyEnabled, "code panel + Copy enabled once a code exists");
	s.check(!gen.showQr, "QR block stays hidden until the QR actually rendered");

	const qrDone = p2pWizardView({ phase: "awaiting-peer", role: "create", code: "YAOS-P2P1:x", qrRendered: true, joinValue: "" });
	s.check(qrDone.showQr, "QR block shown once rendered");

	const typing = p2pWizardView({ phase: "idle", role: "join", code: "", qrRendered: false, joinValue: "  YAOS-P2P1:x " });
	s.check(typing.role === "join", "role is carried through");
	s.check(typing.joinEnabled, "Join enabled once the field has text (trimmed)");
}

s.section("2: generate records the code and deep link");
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
		const vm = flow.view();
		s.check(vm.showCodePanel && vm.copyEnabled && !vm.showQr, "view model: code panel + Copy on, QR off (not rendered without a DOM)");
	});
}

s.section("3: join trims input; empty input is a no-op");
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

s.section("4: the deep-link prefill is consumed exactly once and switches to the join step");
{
	const { host } = fakeSpike();
	const flow = new P2pPairingFlow(host);
	s.check(flow.consumeJoinPrefill() === null, "no prefill before one arrives");
	s.check(flow.view().role === "create", "role stays create without a prefill");

	flow.prefillJoin("  YAOS-P2P1:test-vault:pre-filled  ");
	s.check(flow.view().role === "join", "the prefill switches the wizard to the join step");
	const first = flow.consumeJoinPrefill();
	const second = flow.consumeJoinPrefill();
	s.check(first === "YAOS-P2P1:test-vault:pre-filled", `the prefill is consumed, trimmed (${first ?? "null"})`);
	s.check(second === null, "the prefill is consumed exactly once");

	flow.prefillJoin("");
	s.check(flow.consumeJoinPrefill() === null, "a blank prefill is ignored");
}

s.section("5: disconnect clears the generated code and the QR state");
{
	const { host, calls } = fakeSpike();
	const flow = new P2pPairingFlow(host);

	s.test("disconnect() closes the link and forgets the code + QR", async () => {
		await flow.generate();
		s.check(flow.lastGeneratedCode !== null, "a code exists before disconnect");
		flow.disconnect();
		s.check(calls.includes("close"), "the host link was closed");
		s.check(flow.lastGeneratedCode === null && flow.lastGeneratedDeepLink === null, "code and deep link are cleared");
		s.check(!flow.qrRendered, "the QR state is reset");
		s.check(!flow.view().showCodePanel && !flow.view().showQr, "view model: code panel and QR off after disconnect");
		s.check(flow.state().phase === "closed", "the host phase is closed");
	});
}

s.section("6: update() is safe without a mount and never swallows the prefill");
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
	s.check(flow.view().role === "join", "the role survives an unmounted update()");
}

await s.done();
