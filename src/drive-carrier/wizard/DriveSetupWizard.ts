import { App, Modal } from "obsidian";
import { buildScreen, type ActionId, type Block, type ButtonDef, type Field } from "./screens";
import { WizardController, type WizardDeps } from "./wizardController";

/**
 * The window of the Google Drive setup wizard. It only draws what `screens.ts`
 * describes and passes clicks to the controller; the rules live there.
 */
export class DriveSetupWizard extends Modal {
	private readonly controller: WizardController;

	constructor(app: App, deps: Omit<WizardDeps, "onChange" | "onClose">) {
		super(app);
		this.controller = new WizardController({
			...deps,
			onChange: () => this.render(),
			onClose: () => this.close(),
		});
	}

	onOpen(): void {
		this.modalEl.addClass("yaos-drive-wizard");
		this.render();
	}

	onClose(): void {
		this.controller.cancel();
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		const focused = contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-wizard-field]:focus");
		const focusKey = focused?.dataset.wizardField ?? null;
		const selectionStart = focused?.selectionStart ?? null;
		const selectionEnd = focused?.selectionEnd ?? null;
		const screen = buildScreen(this.controller);
		contentEl.empty();
		contentEl.createEl("h3", { text: screen.title });
		if (screen.progress) contentEl.createDiv({ text: screen.progress, cls: "yaos-wizard-progress" });
		for (const block of screen.body) this.renderBlock(contentEl, block);
		for (const field of screen.fields) this.renderField(contentEl, field);
		if (screen.busy) contentEl.createEl("p", { text: screen.busy, cls: "yaos-wizard-busy" });
		if (screen.error) contentEl.createDiv({ text: screen.error, cls: "yaos-wizard-note yaos-wizard-warn" });
		const row = contentEl.createDiv({ cls: "modal-button-container yaos-wizard-buttons" });
		for (const button of screen.buttons) this.renderButton(row, button);
		if (focusKey) {
			const again = contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-wizard-field="${focusKey}"]`);
			if (again) {
				again.focus();
				if (selectionStart !== null && selectionEnd !== null) {
					try { again.setSelectionRange(selectionStart, selectionEnd); } catch { /* checkboxes have no selection */ }
				}
			}
		}
	}

	private renderBlock(parent: HTMLElement, block: Block): void {
		switch (block.kind) {
			case "p":
				parent.createEl("p", { text: block.text });
				return;
			case "steps": {
				const list = parent.createEl("ol");
				for (const item of block.items) list.createEl("li", { text: item });
				return;
			}
			case "note":
				parent.createDiv({ text: block.text, cls: `yaos-wizard-note yaos-wizard-${block.tone}` });
				return;
			case "code":
				parent.createDiv({ text: block.text, cls: "yaos-drive-signin-code yaos-wizard-code" });
				return;
			case "checklist": {
				const list = parent.createEl("ul", { cls: "yaos-wizard-checklist" });
				for (const item of block.items) {
					const mark = item.status === "done" ? "✓" : item.status === "failed" ? "✗" : item.status === "running" ? "…" : "○";
					list.createEl("li", { text: `${mark} ${item.label}` });
				}
				return;
			}
			case "link": {
				const button = parent.createEl("button", { text: block.label, cls: "mod-cta yaos-wizard-link-button" });
				button.addEventListener("click", () => this.controller.open(block.url));
				return;
			}
		}
	}

	private renderField(parent: HTMLElement, field: Field): void {
		const wrap = parent.createDiv({ cls: "yaos-wizard-field" });
		if (field.type === "checkbox") {
			const label = wrap.createEl("label", { cls: "yaos-wizard-check" });
			const box = label.createEl("input", { type: "checkbox" });
			box.checked = field.value === true;
			box.dataset.wizardField = field.key;
			label.appendText(` ${field.label}`);
			box.addEventListener("change", () => this.controller.setFieldByKey(field.key, box.checked));
		} else {
			wrap.createEl("label", { text: field.label });
			const input = field.type === "textarea"
				? wrap.createEl("textarea", { cls: "yaos-wizard-input" })
				: wrap.createEl("input", { type: field.type, cls: "yaos-wizard-input" });
			input.value = String(field.value);
			if (field.placeholder) input.placeholder = field.placeholder;
			input.dataset.wizardField = field.key;
			input.spellcheck = false;
			input.addEventListener("input", () => this.controller.setFieldByKey(field.key, input.value));
		}
		if (field.help) wrap.createDiv({ text: field.help, cls: "yaos-wizard-help" });
		if (field.problem) wrap.createDiv({ text: field.problem, cls: "yaos-wizard-problem" });
	}

	private renderButton(parent: HTMLElement, def: ButtonDef): void {
		const button = parent.createEl("button", { text: def.label });
		if (def.kind === "primary") button.addClass("mod-cta");
		if (def.kind === "link") button.addClass("yaos-wizard-plain");
		button.disabled = def.disabled === true;
		button.addEventListener("click", () => { void this.perform(def.action); });
	}

	private async perform(action: ActionId): Promise<void> {
		const c = this.controller;
		switch (action) {
			case "next": await c.next(); return;
			case "back": await c.back(); return;
			case "cancel": c.cancel(); return;
			case "retry": await c.retry(); return;
			case "choose-new": c.choosePath("new"); return;
			case "choose-join": c.choosePath("join"); return;
			case "client-bundled": c.chooseClient("bundled"); return;
			case "client-own": c.chooseClient("own"); return;
			case "copy-code": await c.copySetupCode(); return;
			case "copy-signin-code":
				if (c.state.signIn) await c.copyText(c.state.signIn.userCode);
				return;
			case "clear-join-passphrase":
				c.setJoinPassphrase("");
				await c.retry();
				return;
			case "reload": c.reload(); return;
			case "close": this.close(); return;
		}
	}
}
