#!/usr/bin/env node
/**
 * F3: documentation truth, enforced.
 *
 * SYNC-01 and SYNC-02 are resolved in code and pinned by their suites, and
 * `sync-contract.md`, `BACKLOG.md` and `qa.md` now say so. The failure mode this
 * guards against is silent: someone edits one of those documents (or pastes back
 * an older paragraph) and the repo starts claiming again that a fixed defect is
 * still open — which is exactly the state the review found.
 *
 * Each row pairs a phrase that only makes sense while an item is **unresolved**
 * with the regression suites that exist because it **is** resolved. The check is
 * conditional on both: if the evidence file is present (it is, in this tree) and
 * the phrase comes back in the named document, this suite fails and quotes it.
 * Delete a row only by deleting the suites it points at as well.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, suite } from "../harness.ts";

const s = suite("docs-claim-drift");

interface Claim {
	/** Document that must not claim the item is open. */
	doc: string;
	/** Verbatim wording the documents used while the item was open. */
	phrase: string;
	/** Suites that exist because the item is fixed; the check needs all of them. */
	evidence: string[];
}

const CLAIMS: Claim[] = [
	{
		doc: "docs/BACKLOG.md",
		phrase: "Known failing behavior hidden as an expected failure",
		evidence: ["tests/client/engine-offline-delete.ts", "qa/controllers/two-device.ts"],
	},
	{
		doc: "docs/BACKLOG.md",
		phrase: "Open correctness gap with real iPad trace history",
		evidence: ["tests/client/engine-bound-both-changed.ts"],
	},
	{
		doc: "docs/sync-contract.md",
		phrase: "A known gap remains when both disk and CRDT changed from baseline",
		evidence: ["src/runtime/reconcile/boundDivergencePolicy.ts"],
	},
	{
		doc: "docs/sync-contract.md",
		phrase: "A separate known violation exists for a file deleted locally",
		evidence: ["src/runtime/reconcile/offlineDeletePolicy.ts"],
	},
	{
		doc: "docs/qa.md",
		phrase: "must become a hard failing test before its fix",
		evidence: ["tests/client/engine-offline-delete.ts"],
	},
];

for (const claim of CLAIMS) {
	// The claim is only stale if the work it describes is actually done: without
	// the evidence the phrase would be honest again, so say so rather than fail.
	const missingEvidence = claim.evidence.filter((file) => !existsSync(join(repoRoot(), file)));
	s.check(missingEvidence.length === 0, `${claim.evidence.join(", ")} still exists (the fix is in the tree)`);

	const docPath = join(repoRoot(), claim.doc);
	s.check(existsSync(docPath), `${claim.doc} exists`);
	if (!existsSync(docPath)) continue;
	const text = readFileSync(docPath, "utf8");
	s.check(
		!text.includes(claim.phrase),
		`${claim.doc} no longer says "${claim.phrase}" while its fix is covered`,
	);
}

// The resolved wording has to be findable, so a reader (and the next reviewer)
// can tell the items were closed rather than quietly dropped from the list.
const backlog = readFileSync(join(repoRoot(), "docs/BACKLOG.md"), "utf8");
const contract = readFileSync(join(repoRoot(), "docs/sync-contract.md"), "utf8");
s.check(backlog.includes("## Resolved since this list was written") && backlog.includes("SYNC-01") && backlog.includes("SYNC-02"), "BACKLOG.md names both items as resolved, with the section that carries the evidence");
s.check(contract.includes("offlineDeletePolicy.ts") && contract.includes("boundDivergencePolicy.ts"), "sync-contract.md points at the modules that implement the two rules");

await s.done();
