# Next-phase plan — carrier-gated P2P settings (Milestone A) + Phase 1 core (Milestone B)

Date: 2026-10-03. Status: **PLAN ONLY — nothing implemented yet.** Supersedes the
Round-8 "always visible" deviation (`.12`): the user's expectation is that P2P
settings are visible **only when P2P is the selected sync carrier**. This
restores the locked plan §8 shape exactly (P2P is a carrier-dropdown option).

Decisions locked via interactive questions (2026-10-03):

| Question | Decision |
|---|---|
| Carrier model | **P2P = third option in the "Sync carrier (experimental)" dropdown.** Selecting it (reload required) shows the P2P group and hides the Drive/CF sync pages. While selected, normal note sync does not run; P2P becomes the real carrier in Phase 1. |
| Scope | **One work stream, two releases:** UI fix ships as **`.13`** (so the user can test the gate legs on the corrected surface), then Phase 1 core (T1.1–T1.7) built in the same stream and shipped as **one final release (`.14`)**. |
| Phase 0 gate | **Not yet run** — user runs the device legs (T0.1–T0.5) on the `.13` build; feasibility §6–7 + gate call happen after, before Milestone B is considered done. |
| Dormancy | **Fully dormant when carrier ≠ P2P:** spike host never initializes, no P2P status-bar item, pairing deep link is a no-op, debug command/DevTools API absent. Only the settings *layout* of other carriers must stay byte-identical (revert the `.12` additions). |

Zero-regression constraint still in force: every change additive or
restore-to-pre-`.12`; full regression suite gates each commit.

---

## Milestone A — carrier-gated P2P settings, release `2.1.1-drive.13` (Latest)

### A1. `src/drive-carrier/carrierSettings.ts` — add the carrier kind

- `CarrierKind = "cloudflare" | "drive" | "p2p"`.
- `isCarrierKind` accepts `"p2p"`; `currentCarrier` unchanged in its
  invariants (absent/unknown value still → `"cloudflare"` — the existing
  `drive-carrier-settings.ts` checks at l.126–129 stay green as-is).
- New helper `isP2pCarrier(settings): boolean`.

### A2. `src/settings/settingsTab.ts` — gate the group, add the P2P layout

- `CARRIER_OPTIONS` gains `p2p: "P2P (experimental)"`.
- `withP2pSection` renders the group **only when `currentCarrier(host.settings) === "p2p"`**;
  otherwise returns `definitions` untouched.
- **P2P mode layout** (carrier === p2p): the tab shows a single
  "P2P (experimental)" group, with the **carrier row first** (so the user can
  switch back — same pattern as the Drive group), then the existing `.12` rows
  (Direct P2P link, This vault, Backbone (optional) with disabled options,
  TURN URL/username/credential, Pair another device (QR + code), P2P network
  check). The Drive/CF-specific pages (Setup, Sync status, Manual connection,
  Attachments, …) are not shown — the spike carrier has no note sync yet.
- Drive and Cloudflare layouts: **restored to their pre-`.12` shape** (the
  appended group goes away from them).

### A3. `src/main.ts` — dormancy

All P2P runtime effects are gated on `isP2pCarrier(this.settings)` at onload
(carrier change needs a reload, so no live re-init is required):

- Spike host construction + `applyP2pTurnOverrides()` — only when p2p.
- P2P status-bar item + 1 s timer — only when p2p (no item at all otherwise).
- `p2p-spike-panel` command registration (debug-gated as before) — only when p2p.
- `__YAOS_P2P_DEBUG__` — only when p2p.
- Deep link `obsidian://yaos?action=p2p-pair&code=…` when carrier ≠ p2p:
  **no-op** with a short Notice ("Select the P2P carrier in Settings to accept
  a pairing") — detail the user may reject.
- `onunload` teardown stays null-safe (fields simply stay `null`).
- The rest of the plugin's sync machinery is untouched: with carrier = p2p the
  existing code path is the same "unconfigured Cloudflare" idle state — no
  sync attempt, no crash (verified against every `isDriveCarrier` branch in
  `main.ts`; none special-cases a third kind).

### A4. Tests

- `tests/client/drive-carrier-settings.ts`: **revert** the two
  group-inventory expectations to their pre-`.12` strings (P2P group no longer
  in Drive/CF layouts); `currentCarrier`/`isCarrierKind` checks keep their
  existing invariants; add: `currentCarrier({ carrier: "p2p" }) === "p2p"`,
  `isCarrierKind("p2p")`, `isP2pCarrier` truth table, and an explicit
  "no P2P wording in any Drive/CF layout" check.
- `tests/client/p2p-settings-surface.ts` (27 checks, carrier-gated rewrite):
  mock host's `settings` gains a mutable `carrier`; group present **only** for
  `p2p`, absent for `drive`/`cloudflare`/absent; carrier row present and
  first in the P2P group; all `.12` row wiring checks carried over under
  `carrier: "p2p"`.
- Tab-level dormancy checks: no P2P rows leak into other carrier layouts;
  host-method-less host still renders the group rows read-only (unchanged).
- `main.ts` dormancy (host/status bar/command absent for non-p2p carriers) is
  verified by the `.13` manual pass (Obsidian plugin level, not unit-testable
  here) — noted in the release notes as the manual-verification item.

### A5. Docs

- `qa/p2p-spike/runbook.md`: prerequisites now **start with "select
  P2P (experimental) as the sync carrier" + reload**; debug mode becomes fully
  optional (only for DevTools/console on desktop).
- `docs/p2p/feasibility.md` §5: replace the "T1.3 surface pulled forward,
  always visible" note with "surface restored to plan §8 shape (carrier-gated);
  dormant unless P2P carrier selected".

### A6. Gate + release

Full gate (tsc, regression — now 127 suites again after the rewrite, build,
3 guards, `lint:changed`) → commit → push `p2p-implementation` → tag
`2.1.1-drive.13` → release **Latest, not pre-release** (PAT still valid) with
`main.js`, `manifest.json`, `styles.css`, `yaos-drive-2.1.1-drive.13.zip`.
Then: **user runs the device legs** (runbook §3–§7) on desktop + Android;
results feed feasibility §6 (T0.1–T0.5 evidence) + §7 gate call.

---

## Milestone B — Phase 1: `P2pCarrier` core (T1.1–T1.7), one release at the end

Built in the same work stream after `.13` ships (and after the gate legs are
reported — the gate call is recorded either way before `.14` is released).
Full task specs live in the locked plan (`docs/p2p-plan.md` §9 Phase 1);
build order here:

1. **T1.1 frame protocol** — new `src/p2p/frame.ts`: sync / awareness /
   control frames over the data channel; blob & snapshot frames stubbed until
   Phase 3. Pure codec → unit-tested immediately.
2. **T1.4 test infra (early slice)** — `FakePeerConnection` (in-memory
   loopback with injected loss/delay/drops) so everything after step 2 is
   testable without real WebRTC.
3. **T1.2 composite carrier** — `p2pCarrier.ts`, `peerLink.ts`, `ice.ts`,
   `routingPolicy.ts`, `docRegistry.ts` (§4.2.3 `__yaos.peers`/`__yaos.meta`,
   LWW, size bounds, vault secret), `mergedAwareness.ts`. P2P implements the
   real carrier contract (`origin === "carrier"`, `status`/`synced`
   semantics); **backbone adapter `null | Drive | CF`** (A1/A2) becomes real;
   new store key `p2pBackbone` (the `.12` surface-only deviation ends here);
   "P2P + None is a legal final state — vault created locally" per plan §8.
4. **T1.3 settings completion** — backbone selector turns from disabled
   placeholder into the real control (None/Cloudflare*/Drive with the §8
   copy); **cellular data saver (A4)** row (backbone on mobile data, on by
   default); wizard first screen ("How will your devices find each other?");
   status-bar copy per §4.10 (already built in `.12`, unchanged).
5. **T1.5 fuzz** — `p2p-fuzz` suite (fixed seeds, ~6 s CI budget,
   `drive-carrier-fuzz` pattern): open/close churn, duplicate two-path
   delivery, mid-transfer restarts, secret rotation mid-session. Invariants:
   convergence, no lost local edit, receipt honesty.
6. **T1.6 STUN refresh (B4)** — re-gather on network change + ≤ 1×/24 h;
   registry offer written only when the candidate changed.
7. **T1.7 network-change triggers (A3)** — foreground / network-return /
   Wi-Fi↔cellular each trigger backbone poll + background direct attempt;
   plus the `docs/sync-contract.md` receipt subsection from §4.10.

**Exit (per plan):** two desktop instances sync live over a direct link with
backbone `None`; backbone on ⇒ same scenarios pass with backbone fallback;
toggle matrix green. On top of that: full regression (127 + all new suites)
green, tsc, build, 3 guards, `lint:changed` → commit → push → tag
`2.1.1-drive.14` → release **Latest** (manual, PAT) → user re-tests on
devices per the updated runbook.

### Risks & mitigations (both milestones)

| Risk | Mitigation |
|---|---|
| P2P carrier mode hides *all* existing settings pages — user might expect Attachments/etc. to remain | Intentional (spike carrier has no note sync yet); the carrier row is always present to switch back; documented in the release notes. Flag during the `.13` review. |
| Dormancy is a behavioral *reduction* vs `.12` (status bar/deep link/command disappear for non-p2p carriers) | Explicit user decision (2026-10-03); the 127-suite regression pins that nothing *else* changed. |
| Phase 1 is large (new carrier contract, CRDT registry, fuzz) | Test-first build order; every task lands with its unit tests green before the next; the suite count only grows. |
| Gate evidence pending while Milestone B builds | Legs run on `.13` in parallel with B's early tasks (T1.1/T1.4 need no device); the gate call is written before `.14` release regardless of outcome (no-go ⇒ per plan, that platform gets backbone-assisted mode + diagnostic row, architecture unchanged). |
| Old PAT still live (release automation) | Manual release route as before; revoke reminder repeated with `.13` and `.14` release notes. |

### Deviations carried / closed

- **Closed:** "P2P group always visible" (Round 8, user's `.12`-era choice) —
  superseded by carrier-gating, which is the plan §8 shape.
- **Open until T1.2:** no `p2pBackbone` store key (surface-only disabled text
  stays in `.13`; the key lands with the real backbone in `.14`).
- **Open:** no styles.css changes (declarative rows use built-in Obsidian
  styles) — unchanged.
- **Open:** manifest stays `2.1.1`, `isDesktopOnly: false`, tag scheme
  `2.1.1-drive.N` — unchanged.
