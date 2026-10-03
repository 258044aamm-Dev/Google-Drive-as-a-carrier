/**
 * P2P pairing flow — the pairing UI on the P2P settings home page
 * (Milestone B2).
 *
 * A thin controller over the spike host: generate pairing code + QR, join
 * with a code, disconnect. The logic methods are DOM-free (mount() is never
 * called in the unit tests), so the flow is testable without a DOM.
 *
 * The dev panel (P2pSpikeModal) keeps its own copy of these controls for
 * debug mode and as the deep-link fallback; this flow is the user surface.
 * All DOM classes are scoped under .yaos-p2p-*.
 */

import { Notice } from "obsidian";
import * as QRCode from "qrcode";
import type { P2pSpikeHost, SpikeState } from "../p2p/spikeHost";

export class P2pPairingFlow {
	private codeEl: HTMLTextAreaElement | null = null;
	private joinEl: HTMLTextAreaElement | null = null;
	private liveEl: HTMLDivElement | null = null;
	private qrCanvas: HTMLCanvasElement | null = null;
	private disconnectBtn: HTMLButtonElement | null = null;
	private lastQrText: string | null = null;
	private pendingJoinCode: string | null = null;
	private lastCode: string | null = null;
	private lastDeepLink: string | null = null;
	private mounted = false;

	constructor(private readonly host: P2pSpikeHost) {}

	/** The last generated code (state inspection / tests). */
	get lastGeneratedCode(): string | null {
		return this.lastCode;
	}

	/** The deep link belonging to the last generated code. */
	get lastGeneratedDeepLink(): string | null {
		return this.lastDeepLink;
	}

	/** A join code pre-filled from the pairing deep link — consumed once. */
	consumeJoinPrefill(): string | null {
		const code = this.pendingJoinCode;
		this.pendingJoinCode = null;
		return code;
	}

	state(): SpikeState {
		return this.host.state();
	}

	/** Generate a pairing code + QR. */
	async generate(): Promise<void> {
		const { code, deepLink } = await this.host.generate();
		this.lastCode = code;
		this.lastDeepLink = deepLink;
		if (this.mounted) {
			if (this.codeEl) this.codeEl.value = code;
			this.renderQr(deepLink);
		}
		this.update();
	}

	/** Join with a code (trimmed). An empty code is a no-op. */
	join(rawCode: string): Promise<unknown> {
		const code = rawCode.trim();
		if (!code) return Promise.resolve();
		return this.host.join(code);
	}

	/** Pre-fill the join input (from the pairing deep link). */
	prefillJoin(code: string): void {
		const trimmed = code.trim();
		if (!trimmed) return;
		this.pendingJoinCode = trimmed;
		this.update();
	}

	/** Close the current link and clear the generated code. */
	disconnect(): void {
		this.host.close();
		this.lastCode = null;
		this.lastDeepLink = null;
		this.lastQrText = null;
		this.update();
	}

	/**
	 * Build the pairing UI into `container`. Returns the unmount function
	 * (the home page calls it from hide()).
	 */
	mount(container: HTMLElement): () => void {
		container.empty();
		container.addClass("yaos-p2p-pair");

		const generateRow = container.createDiv({ cls: "yaos-p2p-row" });
		const genBtn = generateRow.createEl("button", { text: "Generate pairing code", cls: "yaos-p2p-btn" });
		genBtn.addEventListener("click", () => {
			void this.generate().catch((err) => {
				new Notice(err instanceof Error ? err.message : String(err), 8000);
			});
		});

		this.codeEl = container.createEl("textarea", {
			cls: "yaos-p2p-code",
			placeholder: "Pairing code appears here after generation",
		});
		this.codeEl.rows = 3;
		this.codeEl.readOnly = true;

		const copyRow = container.createDiv({ cls: "yaos-p2p-row" });
		const copyBtn = copyRow.createEl("button", { text: "Copy code", cls: "yaos-p2p-btn" });
		copyBtn.addEventListener("click", () => {
			void this.copyText(this.codeEl?.value ?? "", "P2P pairing code copied.");
		});

		const qrWrap = container.createDiv({ cls: "yaos-p2p-qr-wrap" });
		this.qrCanvas = qrWrap.createEl("canvas", { cls: "yaos-p2p-qr-canvas" });
		this.qrCanvas.hidden = true;

		container.createEl("div", { text: "Or join with a code from another device", cls: "yaos-p2p-sub" });
		this.joinEl = container.createEl("textarea", { cls: "yaos-p2p-code", placeholder: "Paste YAOS-P2P1:… code" });
		this.joinEl.rows = 2;

		const joinRow = container.createDiv({ cls: "yaos-p2p-row" });
		const joinBtn = joinRow.createEl("button", { text: "Join", cls: "yaos-p2p-btn" });
		joinBtn.addEventListener("click", () => {
			const code = (this.joinEl?.value ?? "").trim();
			if (!code) {
				new Notice("Paste a pairing code first.", 6000);
				return;
			}
			void this.host.join(code).catch((err) => {
				new Notice(err instanceof Error ? err.message : String(err), 8000);
			});
		});

		this.disconnectBtn = container.createEl("button", { text: "Disconnect", cls: "yaos-p2p-btn" });
		this.disconnectBtn.addEventListener("click", () => this.disconnect());

		this.liveEl = container.createDiv({ cls: "yaos-p2p-live" });

		this.mounted = true;
		this.update();
		return () => {
			this.mounted = false;
			this.codeEl = null;
			this.joinEl = null;
			this.liveEl = null;
			this.qrCanvas = null;
			this.disconnectBtn = null;
			this.lastQrText = null;
		};
	}

	/** One-shot state refresh (the home page's timer calls this each second). */
	update(): void {
		if (!this.mounted) return;
		const s = this.host.state();
		const connected = s.phase === "connected";
		if (this.disconnectBtn) this.disconnectBtn.hidden = !connected;
		if (this.liveEl) {
			const link = s.link;
			const parts = [`phase: ${s.phase}`];
			if (s.error) parts.push(s.error);
			parts.push(`ice: ${link?.iceConnectionState ?? "–"}`);
			parts.push(`RTT: ${s.lastRttMs === null ? "–" : `${s.lastRttMs} ms`}`);
			this.liveEl.setText(parts.join(" · "));
		}
		// A pre-filled join code lands in the input exactly once.
		if (this.pendingJoinCode && this.joinEl && !this.joinEl.value) {
			this.joinEl.value = this.pendingJoinCode;
			this.pendingJoinCode = null;
		}
	}

	// ── internals ───────────────────────────────────────────────────

	private renderQr(text: string): void {
		if (this.lastQrText === text && this.qrCanvas && !this.qrCanvas.hidden) return;
		this.lastQrText = text;
		if (!this.qrCanvas) return;
		void QRCode.toCanvas(this.qrCanvas, text, {
			width: 200,
			margin: 1,
			errorCorrectionLevel: "M",
		})
			.then(() => {
				if (this.qrCanvas) this.qrCanvas.hidden = false;
			})
			.catch(() => {
				if (this.qrCanvas) this.qrCanvas.remove();
				this.qrCanvas = null;
			});
	}

	private copyText(text: string, okMessage: string): void {
		if (!text) return;
		void navigator.clipboard.writeText(text).then(
			() => new Notice(okMessage),
			() => new Notice("Clipboard write failed — select the code manually.", 6000),
		);
	}
}
