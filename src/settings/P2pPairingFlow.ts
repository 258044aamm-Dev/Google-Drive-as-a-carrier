/**
 * P2P pairing flow — the pairing wizard on the P2P settings home page
 * (Milestone B3).
 *
 * A role-based wizard: the user picks "Create a pairing code" (on this
 * device) or "Join with a code" (from the other device), and only the
 * selected step is shown. All visibility decisions come from a pure,
 * DOM-free view model (p2pWizardView), so the logic is unit-testable
 * without a DOM; mount() is never called in the unit tests.
 *
 * Visibility is applied through the scoped `.yaos-p2p-hidden`
 * display:none !important class plus `disabled` attributes — NOT the
 * `hidden` attribute alone, which Obsidian theme CSS can override (the
 * drive.15 bug where Disconnect stayed visible while unlinked).
 *
 * The dev panel (P2pSpikeModal) keeps its own copy of these controls for
 * debug mode and as the deep-link fallback; this flow is the user surface.
 * All DOM classes are scoped under .yaos-p2p-*.
 */

import { Notice } from "obsidian";
import * as QRCode from "qrcode";
import type { P2pSpikeHost, SpikePhase, SpikeState } from "../p2p/spikeHost";

export type P2pWizardRole = "create" | "join";

/** Pure, DOM-free snapshot of everything the wizard must show or enable. */
export interface P2pWizardViewModel {
	role: P2pWizardRole;
	/** Disconnect button — only while the link is connected. */
	showDisconnect: boolean;
	/** The generated-code panel (label + code box + copy + QR) — only after generation. */
	showCodePanel: boolean;
	/** The generated code text ("" until generated). */
	code: string;
	/** The QR block — only once the QR has actually rendered. */
	showQr: boolean;
	/** Copy code button. */
	copyEnabled: boolean;
	/** Join button — only while the join field has text. */
	joinEnabled: boolean;
	/** "Generating a new code ends the current link" hint. */
	showGenerateHint: boolean;
}

/**
 * The pure mapping from state to view model (unit-tested without a DOM).
 * `joinValue` is the current text of the join field.
 */
export function p2pWizardView(input: {
	phase: SpikePhase;
	role: P2pWizardRole;
	code: string;
	qrRendered: boolean;
	joinValue: string;
}): P2pWizardViewModel {
	const code = input.code;
	return {
		role: input.role,
		showDisconnect: input.phase === "connected",
		showCodePanel: code !== "",
		code,
		showQr: input.qrRendered && code !== "",
		copyEnabled: code !== "",
		joinEnabled: input.joinValue.trim() !== "",
		showGenerateHint: input.phase === "connected",
	};
}

export class P2pPairingFlow {
	private currentRole: P2pWizardRole = "create";
	private codeEl: HTMLTextAreaElement | null = null;
	private joinEl: HTMLTextAreaElement | null = null;
	private roleCreateBtn: HTMLButtonElement | null = null;
	private roleJoinBtn: HTMLButtonElement | null = null;
	private stepCreate: HTMLDivElement | null = null;
	private stepJoin: HTMLDivElement | null = null;
	private codePanel: HTMLDivElement | null = null;
	private qrBlock: HTMLDivElement | null = null;
	private copyBtn: HTMLButtonElement | null = null;
	private joinBtn: HTMLButtonElement | null = null;
	private disconnectBtn: HTMLButtonElement | null = null;
	private generateHint: HTMLDivElement | null = null;
	private qrCanvas: HTMLCanvasElement | null = null;
	private pendingJoinCode: string | null = null;
	private lastCode: string | null = null;
	private lastDeepLink: string | null = null;
	private lastQrText: string | null = null;
	private qrReady = false;
	private joinValue = "";
	private mounted = false;

	constructor(private readonly host: P2pSpikeHost) {}

	/** The current wizard role (state inspection / tests). */
	get role(): P2pWizardRole {
		return this.currentRole;
	}

	/** Whether the QR has rendered for the current code (tests). */
	get qrRendered(): boolean {
		return this.qrReady;
	}

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

	/** The view model for the current state (pure mapping over our state). */
	view(joinValue?: string): P2pWizardViewModel {
		const s = this.host.state();
		return p2pWizardView({
			phase: s.phase,
			role: this.currentRole,
			code: this.lastCode ?? "",
			qrRendered: this.qrReady,
			joinValue: joinValue ?? this.joinValue,
		});
	}

	/** Switch the wizard role (the role buttons call this). */
	setRole(role: P2pWizardRole): void {
		this.currentRole = role;
		this.update();
	}

	/** Generate a pairing code + QR (always happens in the create step). */
	async generate(): Promise<void> {
		const { code, deepLink } = await this.host.generate();
		this.lastCode = code;
		this.lastDeepLink = deepLink;
		this.qrReady = false;
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

	/** Pre-fill the join input (from the pairing deep link) and switch to the join step. */
	prefillJoin(code: string): void {
		const trimmed = code.trim();
		if (!trimmed) return;
		this.pendingJoinCode = trimmed;
		this.currentRole = "join";
		this.update();
	}

	/** Close the current link and clear the generated code. */
	disconnect(): void {
		this.host.close();
		this.lastCode = null;
		this.lastDeepLink = null;
		this.lastQrText = null;
		this.qrReady = false;
		this.update();
	}

	/**
	 * Build the wizard UI into `container`. Returns the unmount function
	 * (the home page calls it from hide()).
	 */
	mount(container: HTMLElement): () => void {
		container.empty();
		container.addClass("yaos-p2p-wizard");

		this.disconnectBtn = container.createEl("button", { text: "Disconnect", cls: "yaos-p2p-btn yaos-p2p-btn--full" });
		this.disconnectBtn.addEventListener("click", () => this.disconnect());

		const roleGrid = container.createDiv({ cls: "yaos-p2p-role-grid" });
		this.roleCreateBtn = this.createRoleButton(roleGrid, "Create a pairing code", "on this device", "create");
		this.roleJoinBtn = this.createRoleButton(roleGrid, "Join with a code", "from the other device", "join");

		this.stepCreate = container.createDiv({ cls: "yaos-p2p-step" });
		const genBtn = this.stepCreate.createEl("button", { text: "Generate pairing code", cls: "yaos-p2p-btn yaos-p2p-btn--full" });
		genBtn.addEventListener("click", () => {
			void this.generate().catch((err) => {
				new Notice(err instanceof Error ? err.message : String(err), 8000);
			});
		});
		this.generateHint = this.stepCreate.createDiv({ text: "Generating a new code ends the current link.", cls: "yaos-p2p-hint" });

		this.codePanel = this.stepCreate.createDiv({ cls: "yaos-p2p-panel" });
		this.codePanel.createEl("div", { text: "Pairing code", cls: "yaos-p2p-label" });
		this.codeEl = this.codePanel.createEl("textarea", { cls: "yaos-p2p-code" });
		this.codeEl.rows = 3;
		this.codeEl.readOnly = true;
		this.copyBtn = this.codePanel.createEl("button", { text: "Copy code", cls: "yaos-p2p-btn" });
		this.copyBtn.addEventListener("click", () => {
			void this.copyText(this.lastCode ?? "", "P2P pairing code copied.");
		});

		this.qrBlock = this.codePanel.createDiv({ cls: "yaos-p2p-qr-block" });
		this.qrCanvas = this.qrBlock.createEl("canvas", { cls: "yaos-p2p-qr-canvas" });
		this.qrBlock.createEl("div", { text: "Scan this with the other device's camera", cls: "yaos-p2p-qr-caption" });
		const deepLinkBtn = this.qrBlock.createEl("button", { text: "Copy deep link", cls: "yaos-p2p-btn yaos-p2p-btn--subtle" });
		deepLinkBtn.addEventListener("click", () => {
			void this.copyText(this.lastDeepLink ?? "", "P2P deep link copied.");
		});

		this.stepJoin = container.createDiv({ cls: "yaos-p2p-step" });
		this.stepJoin.createEl("div", { text: "Pairing code from the other device", cls: "yaos-p2p-label" });
		this.joinEl = this.stepJoin.createEl("textarea", { cls: "yaos-p2p-code", placeholder: "Paste YAOS-P2P1:…" });
		this.joinEl.rows = 2;
		this.joinEl.addEventListener("input", () => {
			this.joinValue = this.joinEl?.value ?? "";
			this.update();
		});
		this.joinBtn = this.stepJoin.createEl("button", { text: "Join", cls: "yaos-p2p-btn yaos-p2p-btn--full" });
		this.joinBtn.addEventListener("click", () => {
			const code = (this.joinEl?.value ?? "").trim();
			if (!code) return;
			void this.host.join(code).catch((err) => {
				new Notice(err instanceof Error ? err.message : String(err), 8000);
			});
		});

		this.mounted = true;
		this.update();
		return () => {
			this.mounted = false;
			this.codeEl = null;
			this.joinEl = null;
			this.roleCreateBtn = null;
			this.roleJoinBtn = null;
			this.stepCreate = null;
			this.stepJoin = null;
			this.codePanel = null;
			this.qrBlock = null;
			this.copyBtn = null;
			this.joinBtn = null;
			this.disconnectBtn = null;
			this.generateHint = null;
			this.qrCanvas = null;
			this.lastQrText = null;
		};
	}

	/** One-shot state refresh (the home page's timer calls this each second). */
	update(): void {
		if (!this.mounted) return;
		const vm = this.view();
		if (this.roleCreateBtn) this.roleCreateBtn.toggleClass("yaos-p2p-role-btn--active", vm.role === "create");
		if (this.roleJoinBtn) this.roleJoinBtn.toggleClass("yaos-p2p-role-btn--active", vm.role === "join");
		if (this.stepCreate) this.stepCreate.toggleClass("yaos-p2p-hidden", vm.role !== "create");
		if (this.stepJoin) this.stepJoin.toggleClass("yaos-p2p-hidden", vm.role !== "join");
		if (this.disconnectBtn) this.disconnectBtn.toggleClass("yaos-p2p-hidden", !vm.showDisconnect);
		if (this.codePanel) this.codePanel.toggleClass("yaos-p2p-hidden", !vm.showCodePanel);
		if (this.copyBtn) this.copyBtn.disabled = !vm.copyEnabled;
		if (this.qrBlock) this.qrBlock.toggleClass("yaos-p2p-hidden", !vm.showQr);
		if (this.joinBtn) this.joinBtn.disabled = !vm.joinEnabled;
		if (this.generateHint) this.generateHint.toggleClass("yaos-p2p-hidden", !vm.showGenerateHint);
		// Keep the code box in sync without fighting the (read-only) user.
		if (this.codeEl && this.codeEl.value !== vm.code) this.codeEl.value = vm.code;
		// A pre-filled join code lands in the input exactly once.
		if (this.pendingJoinCode && this.joinEl && !this.joinEl.value) {
			this.joinEl.value = this.pendingJoinCode;
			this.joinValue = this.pendingJoinCode;
			this.pendingJoinCode = null;
		}
	}

	// ── internals ───────────────────────────────────────────────────

	private createRoleButton(parent: HTMLElement, title: string, sub: string, role: P2pWizardRole): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "yaos-p2p-role-btn" });
		btn.createSpan({ text: title });
		btn.createSpan({ text: sub, cls: "yaos-p2p-role-btn-sub" });
		btn.addEventListener("click", () => this.setRole(role));
		return btn;
	}

	private renderQr(text: string): void {
		if (this.lastQrText === text && this.qrReady && this.qrCanvas) return;
		this.lastQrText = text;
		this.qrReady = false;
		if (!this.qrCanvas) return;
		void QRCode.toCanvas(this.qrCanvas, text, {
			width: 200,
			margin: 1,
			errorCorrectionLevel: "M",
		})
			.then(() => {
				this.qrReady = true;
				this.update();
			})
			.catch(() => {
				if (this.qrCanvas) this.qrCanvas.remove();
				this.qrCanvas = null;
				this.qrReady = false;
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
