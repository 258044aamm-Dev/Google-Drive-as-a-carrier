/** The first safety gate admits only reviewed JSON projections, never arbitrary config files. */
export const CONFIG_PATHS = ["app.json", "appearance.json", "hotkeys.json"] as const;
export type ConfigPath = typeof CONFIG_PATHS[number];
export const MAX_CONFIG_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export class ConfigSafetyError extends Error {
	constructor(readonly code: string) { super(code); }
}

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configPath(value: unknown): value is ConfigPath {
	return typeof value === "string" && CONFIG_PATHS.some((path) => path === value);
}

/** No normalizing an unsafe remote path into an authorized one. */
export function configRoot(value: string): string {
	if (!value || value.length > 240 || value.includes("\\") || value.startsWith("/") || (value.includes(":") || [...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
		|| value.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new ConfigSafetyError("unsafe-config-directory");
	}
	return value;
}

export async function digest(text: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

const APP_BOOLEANS = new Set([
	"alwaysUpdateLinks", "readableLineLength", "strictLineBreaks", "showLineNumber", "spellcheck",
	"vimMode", "foldHeading", "foldIndent", "autoPairBrackets", "autoPairMarkdown", "smartIndentList",
]);
const MODIFIERS = new Set(["Mod", "Ctrl", "Meta", "Alt", "Shift"]);

/**
 * Export a canonical, bounded projection. Unknown app/appearance fields never
 * leave this device. Plugin settings/code, themes, snippets and workspaces have
 * no admission policy yet and are blocked rather than scanned recursively.
 */
export function projectConfig(path: ConfigPath, raw: string): string {
	if (raw.length > MAX_CONFIG_BYTES || encoder.encode(raw).length > MAX_CONFIG_BYTES) throw new ConfigSafetyError("config-file-too-large");
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new ConfigSafetyError("invalid-config-json"); }
	if (!record(value)) throw new ConfigSafetyError("invalid-config-object");
	const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const key of Object.keys(value).sort()) {
		const item = value[key];
		if (path === "app.json") {
			if (!APP_BOOLEANS.has(key)) continue;
			if (typeof item !== "boolean") throw new ConfigSafetyError("invalid-app-setting");
			out[key] = item;
		} else if (path === "appearance.json") {
			if (key === "baseFontSize") {
				if (typeof item !== "number" || !Number.isInteger(item) || item < 8 || item > 48) throw new ConfigSafetyError("invalid-font-size");
				out[key] = item;
			} else if (key === "theme") {
				if (item !== "obsidian" && item !== "moonstone" && item !== "system") throw new ConfigSafetyError("invalid-theme-setting");
				out[key] = item;
			} else if (key === "accentColor") {
				if (typeof item !== "string" || !/^#[0-9a-fA-F]{6}$/.test(item)) throw new ConfigSafetyError("invalid-accent-color");
				out[key] = item.toLowerCase();
			}
		} else {
			if (!/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(key) || ["constructor", "prototype", "__proto__"].includes(key)
				|| !Array.isArray(item) || item.length > 8) throw new ConfigSafetyError("invalid-hotkey");
			out[key] = item.map((binding: unknown) => {
				if (!record(binding) || Object.keys(binding).some((k) => k !== "modifiers" && k !== "key")
					|| !Array.isArray(binding.modifiers) || binding.modifiers.length > 5
					|| !binding.modifiers.every((mod: unknown) => typeof mod === "string" && MODIFIERS.has(mod))
					|| typeof binding.key !== "string" || !/^[ -~]{1,24}$/.test(binding.key)) throw new ConfigSafetyError("invalid-hotkey-binding");
				return { modifiers: [...new Set(binding.modifiers)].sort(), key: binding.key };
			});
		}
	}
	return JSON.stringify(out);
}
