#!/usr/bin/env node
/**
 * The P2P settings pages (Milestone B2) use styles.css, and the zero-regression
 * constraint requires those styles to be scoped: every selector that mentions
 * p2p must start with `.yaos-p2p-`, so nothing outside the P2P surface can be
 * affected.
 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const bad = [];
for (const raw of css.split("\n")) {
	const t = raw.trim();
	if (!t || t.startsWith("/*") || t.startsWith("*") || t.startsWith("//")) continue;
	if (!/p2p/i.test(t)) continue;
	// Property lines (e.g. "background: ...") are fine — only selector lines
	// (ending in "{" or ",", or a bare selector) must be scoped.
	if (/^[-a-zA-Z]+/.test(t) && t.includes(":") && !t.includes("{")) continue;
	if (!/^\.yaos-p2p-/.test(t)) bad.push(t);
}

if (bad.length > 0) {
	console.error("guard:p2p-css-scope — P2P selectors must all be scoped under .yaos-p2p-:");
	for (const line of bad) console.error("  " + line);
	process.exit(1);
}
console.log("PASS: all P2P styles are scoped under .yaos-p2p-*.");
