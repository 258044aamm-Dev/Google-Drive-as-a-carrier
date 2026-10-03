/**
 * Phase 0 spike panel — the in-app UI for the feasibility checklist.
 *
 * Works on every platform (plain DOM, no desktop-only APIs) so the phone
 * leg needs no CDP: the user opens "P2P spike panel (dev)" from the command
 * palette (visible while the debug setting is on) and runs the same steps
 * as the desktop side. The QR encodes the `obsidian://yaos?action=p2p-pair&
 * code=…` deep link, so a camera-app scan jumps straight to the join view.
 */

import { Modal, Notice } from "obsidian";
import * as QRCode from "qrcode";
import type { P2pSpikeHost, TurnOverride } from "../p2p/spikeHost";

/**
 * Optional TURN bridge: the panel reads the persisted TURN fields on open
 * and persists them again when the user applies an override from the panel,
 * so the settings tab and the panel stay one source of truth.
 */
export interface P2pSpikeTurnState {
	url: string;
	username: string;
	credential: string;
	onSave(turn: TurnOverride[]): void;
}

export class P2pSpikeModal extends Modal {
	private codeEl: HTMLTextAreaElement | null = null;
	private deepLinkEl: HTMLTextAreaElement | null = null;
	private sizeEl: HTMLDivElement | null = null;
	private joinCodeEl: HTMLTextAreaElement | null = null;
	private statusEl: HTMLDivElement | null = null;
	private yjsEl: HTMLTextAreaElement | null = null;
	private yjsStatusEl: HTMLDivElement | null = null;
	private logEl: HTMLPreElement | null = null;
	private qrCanvas: HTMLCanvasElement | null = null;
	private lastQrText: string | null = null;
	private refreshTimer: number | null = null;

	constructor(
		app: Modal["app"],
		private readonly host: P2pSpikeHost,
		private readonly initialCode: string | null,
		private readonly turn?: P2pSpikeTurnState,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-p2p-spike-modal");
		contentEl.createEl("h3", { text: "P2P spike (dev)" });
		contentEl.createEl("p", {
			text: "Phase 0 feasibility panel. Not a user feature — only visible while the debug setting is on.",
			cls: "yaos-modal-copy",
		});

		// ── status row ──────────────────────────────────────────────
		this.statusEl = contentEl.createDiv({ cls: "yaos-p2p-spike-status" });

		// ── anchor ──────────────────────────────────────────────────
		const anchor = createDetailsSection(contentEl, "1 · Anchor — generate pairing code", true);
		const anchorBody = anchor.createDiv({ cls: "yaos-settings-details-body" });
		const genBtn = anchorBody.createEl("button", { text: "Generate pairing code" });
		genBtn.addEventListener("click", () => {
			void this.onGenerate();
		});
		this.sizeEl = anchorBody.createDiv({ cls: "yaos-p2p-spike-size" });
		const codeWrap = anchorBody.createDiv();
		this.codeEl = codeWrap.createEl("textarea", { cls: "yaos-p2p-spike-code" });
		this.codeEl.rows = 3;
		this.codeEl.placeholder = "Pairing code appears here after generation";
		const codeButtons = anchorBody.createDiv({ cls: "modal-button-container" });
		const copyBtn = codeButtons.createEl("button", { text: "Copy code" });
		copyBtn.addEventListener("click", () => {
			const code = this.codeEl?.value ?? "";
			if (!code) return;
			void navigator.clipboard.writeText(code).then(
				() => new Notice("P2P pairing code copied."),
				() => new Notice("Clipboard write failed — select the code manually.", 6000),
			);
		});
		const qrWrap = anchorBody.createDiv({ cls: "yaos-p2p-spike-qr-wrap" });
		this.qrCanvas = qrWrap.createEl("canvas", { cls: "yaos-p2p-spike-qr-canvas" });
		this.qrCanvas.hidden = true;
		const deepDetails = createDetailsSection(anchorBody, "Deep link (manual / no QR)", false);
		const deepBody = deepDetails.createDiv({ cls: "yaos-settings-details-body" });
		this.deepLinkEl = deepBody.createEl("textarea", { cls: "yaos-p2p-spike-code" });
		this.deepLinkEl.rows = 2;
		this.deepLinkEl.placeholder = "obsidian://yaos?action=p2p-pair&code=…";
		const copyDeepBtn = deepBody.createEl("button", { text: "Copy deep link" });
		copyDeepBtn.addEventListener("click", () => {
			const link = this.deepLinkEl?.value ?? "";
			if (!link) return;
			void navigator.clipboard.writeText(link).then(
				() => new Notice("Deep link copied."),
				() => new Notice("Clipboard write failed — select the link manually.", 6000),
			);
		});

		// ── joiner ──────────────────────────────────────────────────
		const joiner = createDetailsSection(contentEl, "2 · Joiner — join with code", this.initialCode !== null);
		const joinBody = joiner.createDiv({ cls: "yaos-settings-details-body" });
		this.joinCodeEl = joinBody.createEl("textarea", { cls: "yaos-p2p-spike-code" });
		this.joinCodeEl.rows = 3;
		this.joinCodeEl.placeholder = "Paste YAOS-P2P1:… code";
		if (this.initialCode) this.joinCodeEl.value = this.initialCode;
		const joinBtn = joinBody.createEl("button", { text: "Join" });
		joinBtn.addEventListener("click", () => {
			const code = this.joinCodeEl?.value.trim() ?? "";
			if (!code) {
				new Notice("Paste a pairing code first.", 6000);
				return;
			}
			void this.host.join(code).catch((err) => {
				new Notice(err instanceof Error ? err.message : String(err), 8000);
			});
		});

		// ── Yjs test ────────────────────────────────────────────────
		const yjsSection = createDetailsSection(contentEl, "3 · Live Yjs test", true);
		const yjsBody = yjsSection.createDiv({ cls: "yaos-settings-details-body" });
		yjsBody.createEl("p", {
			text: "Edits made here replicate over the direct link. Both devices should converge to the same text.",
			cls: "yaos-modal-copy",
		});
		this.yjsEl = yjsBody.createEl("textarea", { cls: "yaos-p2p-spike-code" });
		this.yjsEl.rows = 3;
		this.yjsEl.placeholder = "Type here once connected…";
		this.yjsEl.addEventListener("change", () => {
			if (this.host.state().phase !== "connected") return;
			const value = this.yjsEl?.value ?? "";
			if (value !== this.host.yjsRead()) this.host.yjsEdit(value);
		});
		this.yjsStatusEl = yjsBody.createDiv({ cls: "yaos-p2p-spike-size" });
		const yjsButtons = yjsBody.createDiv({ cls: "modal-button-container" });
		const randomBtn = yjsButtons.createEl("button", { text: "Send random edit" });
		randomBtn.addEventListener("click", () => {
			const stamp = Date.now().toString(36);
			this.host.yjsEdit(`edit-${stamp} from ${Math.floor(Math.random() * 1e6)}`);
		});
		const copyYjsBtn = yjsButtons.createEl("button", { text: "Copy converged text" });
		copyYjsBtn.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.host.yjsRead()).then(
				() => new Notice("Yjs text copied."),
				() => new Notice("Clipboard write failed.", 6000),
			);
		});

		// ── ICE / TURN override (T0.5) ──────────────────────────────
		const iceSection = createDetailsSection(contentEl, "4 · ICE overrides (applies on next pairing)", false);
		const iceBody = iceSection.createDiv({ cls: "yaos-settings-details-body" });
		const turnUrl = iceBody.createEl("input", { type: "text", placeholder: "turn:host:3478" });
		turnUrl.addClass("yaos-p2p-spike-turn-url");
		const turnUser = iceBody.createEl("input", { type: "text", placeholder: "username (optional)" });
		turnUser.addClass("yaos-p2p-spike-turn-user");
		const turnCred = iceBody.createEl("input", { type: "text", placeholder: "credential (optional)" });
		turnCred.addClass("yaos-p2p-spike-turn-cred");
		// Pre-fill from the persisted fields when the settings tab provided them.
		turnUrl.value = this.turn?.url ?? "";
		turnUser.value = this.turn?.username ?? "";
		turnCred.value = this.turn?.credential ?? "";
		const applyBtn = iceBody.createEl("button", { text: "Apply TURN" });
		applyBtn.addEventListener("click", () => {
			const url = turnUrl.value.trim();
			if (!url) {
				new Notice("TURN URL is empty.", 6000);
				return;
			}
			const overrides: TurnOverride[] = [
				{ url, username: turnUser.value.trim() || undefined, credential: turnCred.value.trim() || undefined },
			];
			this.host.setTurnOverrides(overrides);
			this.turn?.onSave(overrides); // persist to settings (no-op without the bridge)
			new Notice("TURN override applied — generate/join again to use it.", 8000);
		});
		const clearBtn = iceBody.createEl("button", { text: "Clear overrides" });
		clearBtn.addEventListener("click", () => {
			this.host.setTurnOverrides([]);
			new Notice("ICE overrides cleared.", 6000);
		});

		// ── log + teardown ──────────────────────────────────────────
		const bottomButtons = contentEl.createDiv({ cls: "modal-button-container" });
		const pingBtn = bottomButtons.createEl("button", { text: "Ping" });
		pingBtn.addEventListener("click", () => {
			void this.host.ping().then((rtt) => {
				new Notice(rtt === null ? "Ping failed (no open link or no reply in 5 s)." : `RTT ${rtt} ms`, 6000);
			});
		});
		const pingLoopBtn = bottomButtons.createEl("button", { text: "Ping ×5" });
		pingLoopBtn.addEventListener("click", () => {
			void (async () => {
				const results: number[] = [];
				for (let i = 0; i < 5; i++) {
					const rtt = await this.host.ping(3000);
					if (rtt !== null) results.push(rtt);
					await sleep(200);
				}
				new Notice(
					results.length === 0
						? "All pings failed."
						: `5 pings: ${results.join(" ms, ")} ms (min ${Math.min(...results)}, max ${Math.max(...results)})`,
					8000,
				);
			})();
		});
		const closeLinkBtn = bottomButtons.createEl("button", { text: "Close link" });
		closeLinkBtn.addEventListener("click", () => {
			this.host.close();
		});

		this.logEl = contentEl.createEl("pre", { cls: "yaos-p2p-spike-log" });

		this.render();
		this.refreshTimer = window.setInterval(() => this.render(), 700);
	}

	onClose(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	// ── internals ───────────────────────────────────────────────────

	private async onGenerate(): Promise<void> {
		try {
			const { code, deepLink, gathering } = await this.host.generate();
			if (this.codeEl) this.codeEl.value = code;
			if (this.deepLinkEl) this.deepLinkEl.value = deepLink;
			this.renderSizeLine(gathering);
			this.renderQr(deepLink);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err), 8000);
		}
		this.render();
	}

	private renderSizeLine(gathering: "complete" | "timeout"): void {
		const s = this.host.state();
		if (!this.sizeEl) return;
		this.sizeEl.setText(
			`code ${s.codeCharLength} chars / ${s.codeByteLength} bytes · ` +
				`candidates ${s.candidates.total} ` +
				`(host ${s.candidates.byType.host}, srflx ${s.candidates.byType.srflx}, relay ${s.candidates.byType.relay}) · ` +
				`gathering ${gathering}`,
		);
	}

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

	private render(): void {
		const s = this.host.state();
		if (this.statusEl) {
			const link = s.link;
			this.statusEl.setText(
				`phase: ${s.phase}${s.error ? ` — ${s.error}` : ""} · ` +
					`ice: ${link?.iceConnectionState ?? "–"} · ` +
					`conn: ${link?.rtcConnectionState ?? "–"} · ` +
					`channel: ${link?.channelState ?? "–"} · ` +
					`RTT: ${s.lastRttMs === null ? "–" : s.lastRttMs + " ms"}`,
			);
		}
		if (this.yjsEl && s.phase === "connected" && this.yjsEl.value !== this.host.yjsRead()) {
			this.yjsEl.value = this.host.yjsRead();
		}
		if (this.yjsStatusEl) {
			const y = s.yjs;
			this.yjsStatusEl.setText(
				y
					? `yjs: ${y.synced ? "synced" : "syncing…"} · local edits ${y.localEdits} · remote edits ${y.remoteEdits} · ${y.receivedBytes} bytes received`
					: "yjs: not attached",
			);
		}
		if (this.logEl) {
			const entries = this.host.logEntries(200);
			this.logEl.setText(
				entries
					.map((e) => `${new Date(e.t).toISOString().slice(11, 23)}  ${e.msg}`)
					.join("\n"),
			);
			this.logEl.scrollTop = this.logEl.scrollHeight;
		}
	}
}

function createDetailsSection(containerEl: HTMLElement, title: string, open = false): HTMLDetailsElement {
	const detailsEl = containerEl.createEl("details", { cls: "yaos-settings-details" });
	detailsEl.open = open;
	detailsEl.createEl("summary", {
		text: title,
		cls: "yaos-settings-details-summary",
	});
	return detailsEl;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
