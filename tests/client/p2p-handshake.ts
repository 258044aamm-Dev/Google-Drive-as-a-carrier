/**
 * P2P pairing handshake — the two-way exchange.
 *
 * Regression guard for the Phase 0 defect found in review: the pairing code
 * carried only the creator's offer and nothing ever returned the joiner's
 * answer, so the offerer never learned the joiner's ICE credentials / DTLS
 * fingerprint and the link could not open. The fake peer connection opens a
 * channel only after the offerer applied the answer, as the real thing does.
 */
import { P2pSpikeHost } from "../../src/p2p/spikeHost";
import { decodeAnswerCode, decodePairingCode } from "../../src/p2p/spikeOffer";
import { suite } from "../harness.ts";
import { installFakeRtc } from "../mocks/fakeRtc";

const s = suite("p2p-handshake");

const tick = async (n = 20): Promise<void> => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

async function refused(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run();
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

const restore = installFakeRtc();
try {
	s.section("1: an offer alone never opens the link; the answer does");
	{
		const a = new P2pSpikeHost(() => "vault-a");
		const b = new P2pSpikeHost(() => "vault-a");
		const { code } = await a.generate();
		s.check(a.state().phase === "awaiting-peer", "the creator waits after generating the code");
		s.check(a.state().answerCode === null, "the creator has no answer code");

		const joined = await b.join(code);
		await tick();
		s.check(joined.answerCode.startsWith("YAOS-P2P1-ANS:"), "joining returns an answer code to send back");
		s.check(b.state().answerCode === joined.answerCode, "the answer code is also in the joiner's state");
		s.check(b.state().phase === "connecting", "the joiner waits for the creator to accept the answer");
		s.check(a.state().phase === "awaiting-peer", "OFFER ONLY: the creator is still waiting, nothing opened");

		await a.acceptAnswer(joined.answerCode);
		await tick();
		s.check(a.state().phase === "connected" && b.state().phase === "connected", "after the answer is applied both sides are connected");

		a.yjsEdit("hello over the link");
		await tick(60);
		s.check(b.yjsRead() === "hello over the link", `Yjs converges across the handshaken link (${b.yjsRead()})`);
		b.yjsEdit("reply");
		await tick(60);
		s.check(a.yjsRead() === "reply", "and in the other direction");
		const rtt = await Promise.race([a.ping(2000), new Promise<string>((r) => setTimeout(() => r("hung"), 3000))]);
		s.check(typeof rtt === "number", `ping settles with the round-trip time over the open link (${String(rtt)})`);
		const pending = a.ping(60000);
		a.close();
		const afterClose = await Promise.race([pending, new Promise<string>((r) => setTimeout(() => r("hung"), 3000))]);
		s.check(afterClose === null, `a ping in flight settles with null when the link is closed (${String(afterClose)})`);
		a.destroy();
		b.destroy();
	}

	s.section("2: wrong or misplaced codes are refused with a clear message");
	{
		const a = new P2pSpikeHost(() => "v");
		const b = new P2pSpikeHost(() => "v");
		const c = new P2pSpikeHost(() => "v");
		const first = await a.generate();
		const staleAnswer = (await b.join(first.code)).answerCode;
		const second = await a.generate(); // regenerating invalidates the old code
		const decodedSecond = decodePairingCode(second.code);
		s.check(decodedSecond !== null, "second code decodes");

		const stale = await refused(() => a.acceptAnswer(staleAnswer));
		s.check(stale !== null && stale.includes("different pairing code"), `a stale answer is refused (${stale ?? "accepted!"})`);
		s.check(a.state().phase === "awaiting-peer", "a refused answer leaves the creator waiting");

		const asAnswer = await refused(() => a.acceptAnswer(second.code));
		s.check(asAnswer !== null && asAnswer.includes("pairing code"), `a pairing code pasted as an answer is refused (${asAnswer ?? "accepted!"})`);
		const garbage = await refused(() => a.acceptAnswer("hello"));
		s.check(garbage !== null && garbage.includes("not a valid answer code"), `garbage is refused (${garbage ?? "accepted!"})`);
		const asOffer = await refused(() => c.join(staleAnswer));
		s.check(asOffer !== null && asOffer.includes("answer code"), `an answer code pasted into Join is refused (${asOffer ?? "accepted!"})`);
		s.check(c.state().phase === "idle", "a refused join changes nothing");

		const good = (await c.join(second.code)).answerCode;
		const decodedGood = decodeAnswerCode(good);
		s.check(decodedGood !== null && decodedGood.vaultId === "v", "the answer carries the joiner's vault id");
		await a.acceptAnswer(good);
		await tick();
		s.check(a.state().phase === "connected", "the matching answer connects");
		const twice = await refused(() => a.acceptAnswer(good));
		s.check(twice !== null && twice.includes("no pairing code is waiting"), `a second answer is refused (${twice ?? "accepted!"})`);

		const idle = new P2pSpikeHost(() => "v");
		const none = await refused(() => idle.acceptAnswer(good));
		s.check(none !== null && none.includes("generate a code first"), `an answer without a code is refused (${none ?? "accepted!"})`);
		for (const h of [a, b, c, idle]) h.destroy();
	}

	s.section("3: closing resets the answer state");
	{
		const a = new P2pSpikeHost(() => "v");
		const b = new P2pSpikeHost(() => "v");
		const { code } = await a.generate();
		await b.join(code);
		s.check(b.state().answerCode !== null, "answer code present after joining");
		b.close();
		s.check(b.state().answerCode === null && b.state().phase === "idle", "close clears the answer code");
		a.close();
		const none = await refused(() => a.acceptAnswer("YAOS-P2P1-ANS:v:x:y"));
		s.check(none !== null, "a closed creator accepts no answer");
		a.destroy();
		b.destroy();
	}
} finally {
	restore();
}

await s.done();
