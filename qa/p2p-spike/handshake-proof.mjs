// Real-browser proof of the P2P pairing handshake (not part of the regression run).
//
// Runs the REAL P2pSpikeHost (src/p2p/spikeHost.ts, bundled with esbuild) twice inside
// one headless Chromium page, with the real RTCPeerConnection, and walks the pairing:
//   1. generate  -> pairing code (offer)
//   2. join      -> answer code
//   3. OFFER ONLY: wait, expect the link NOT to open
//   4. acceptAnswer -> expect both hosts connected and a Yjs edit to converge
//
// Usage:  npx playwright install chromium   (once)
//         node qa/p2p-spike/handshake-proof.mjs
// Exit code 0 = handshake works in Chromium; 1 = it does not.
//
// Scope: same machine, loopback/host candidates only. It proves the exchange, not NAT
// traversal between networks (that is the device runbook, T0.5).
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundle = await build({
	stdin: {
		contents: `import { P2pSpikeHost } from "./src/p2p/spikeHost"; window.P2pSpikeHost = P2pSpikeHost;`,
		resolveDir: root,
		loader: "ts",
	},
	bundle: true,
	format: "iife",
	write: false,
	logLevel: "error",
});
const code = bundle.outputFiles[0].text;

const browser = await chromium.launch({ args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("framenavigated", (f) => console.log("[nav]", f.url()));
page.on("crash", () => console.log("[crash]"));
await page.setContent("<html></html>");
await page.addScriptTag({ content: code });

const result = await page.evaluate(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const waitFor = async (fn, ms) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (fn()) return true;
			await sleep(100);
		}
		return fn();
	};
	const a = new window.P2pSpikeHost(() => "proof-vault");
	const b = new window.P2pSpikeHost(() => "proof-vault");
	const out = {};
	const offer = await a.generate();
	out.offerChars = offer.code.length;
	const joined = await b.join(offer.code);
	out.answerChars = joined.answerCode.length;
	await sleep(4000);
	out.offerOnlyOpened = a.state().phase === "connected" || b.state().phase === "connected";
	await a.acceptAnswer(joined.answerCode);
	out.connected = await waitFor(() => a.state().phase === "connected" && b.state().phase === "connected", 15000);
	if (out.connected) {
		a.yjsEdit("proof from A");
		out.yjsConverged = await waitFor(() => b.yjsRead() === "proof from A", 5000);
		b.yjsEdit("proof from B");
		out.yjsBack = await waitFor(() => a.yjsRead() === "proof from B", 5000);
		out.rtt = await a.ping();
	}
	out.phases = [a.state().phase, b.state().phase];
	a.destroy();
	b.destroy();
	return out;
});
await browser.close();
console.log(JSON.stringify(result, null, 2));
const ok = result.offerOnlyOpened === false && result.connected && result.yjsConverged && result.yjsBack;
console.log(ok ? "PASS: the two-way handshake opens a real WebRTC link; an offer alone does not." : "FAIL");
process.exit(ok ? 0 : 1);
