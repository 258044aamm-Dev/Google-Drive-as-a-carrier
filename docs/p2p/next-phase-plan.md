# Next-phase plan — section-based P2P UI (Milestone B) + Phase 1 core (Milestone C)

Date: 2026-10-03. Status: **Milestones A and B SHIPPED** — A (carrier-gated
P2P settings, `2.1.1-drive.13`, commit `7789952`) and B (section-based P2P
UI, `2.1.1-drive.14`, commit `d7ef1a8`), both verified Latest. **Milestone C
(Phase 1 core) is next**, pending the Phase 0 gate legs on the `.14` build.
This plan grew out of the maintainer's 2026-10-03 direction: *"The current
P2P UI should be section-based, beginner-based, and advanced-based"* and
*"Now implement the next phase."*

Decisions locked via interactive questions (2026-10-03, round 10):

| Question | Decision |
|---|---|
| Structure | **Hybrid:** the beginner section sits directly on the P2P screen (immediate pairing path); the advanced section is a **navigable "Advanced" sub-page** (same page pattern the Cloudflare layout already uses). Carrier row stays on top of everything. |
| Content split | **Beginner** = Direct P2P link (plain explanation), Pair another device (QR + code), This vault (peer status). **Advanced** = Backbone (optional), TURN URL/username/credential, P2P network check, Debug mode. |
| Release strategy | **UI rework first as `2.1.1-drive.14`** (Latest) so the section design is verified on both devices; Phase 1 core then ships as **one final release `2.1.1-drive.15`** (Latest), same work stream. |
| Phase 0 gate | User runs the device legs (T0.1–T0.5) on the **`.14`** build; feasibility §6 evidence + §7 gate call are written after that report and **before** `.15` is released. No-go on a platform ⇒ per the locked plan, that platform gets backbone-assisted mode + diagnostic row; architecture unchanged. |

Zero-regression constraint in force: P2P-surface-only changes; Drive/CF
layouts untouched; full 127-suite regression gates every commit.

---

## Target layout (carrier = P2P selected, after reload)

```
Settings > YAOS
├─ [Sync carrier (experimental)]      ← top-level row (dropdown), first item
├─ P2P (experimental)                 ← group: the beginner section, on screen
│   ├─ Direct P2P link                (plain-words explanation)
│   ├─ Pair another device (QR + code)  [action — the primary path]
│   └─ This vault                     (peer status: count/direct·last seen/RTT)
└─ Advanced                           ← navigable sub-page (page pattern)
    ├─ Backbone (optional)            (Phase 1 placeholder, disabled)
    ├─ TURN URL (advanced)
    ├─ TURN username (optional)
    ├─ TURN credential (optional)
    ├─ P2P network check              [action]
    └─ Debug mode                     [toggle — lives here now, not in the group]
```

Rationale: a first-time user sees pairing immediately (no scrolling past
technical rows); returning users get status at the top of the screen; power
controls (relays, diagnostics, dev tools) are one navigation tap away without
cluttering the beginner path. `SettingDefinitionPage` is the in-codebase
pattern (CF layout's "Manual connection"/"Advanced" pages); a group holds
`SettingDefinition`s, a page holds the same, and top-level arrays mix bare
rows + groups + pages in order.

---

## Milestone B — section-based P2P UI, release `2.1.1-drive.14` (Latest)

### B1. `src/settings/settingsTab.ts` — reshape the P2P layout

- `p2pGroup(carrierRow)` → split into:
  - **top-level `carrierRow`** (bare `SettingDefinition` as the first tab item),
  - **`p2pBeginnerGroup()`** — group, heading "P2P (experimental)":
    Direct P2P link / Pair another device (QR + code) / This vault,
  - **`p2pAdvancedPage()`** — page, name "Advanced":
    Backbone (optional) / TURN URL / TURN username / TURN credential /
    P2P network check / Debug mode.
- `applyCarrierChoice` p2p branch:
  `return [this.carrierRow(), this.p2pBeginnerGroup(), this.p2pAdvancedPage()];`
- Row definitions, wording, keys, and host-method wiring are **unchanged**
  (same `p2pTurn*` keys, same `openP2pPanel`/`runP2pNetworkCheck`/
  `getP2pPeerSummary`/`applyP2pTurn` bridge) — only the container changes,
  so nothing functional moves.

### B2. `src/main.ts` — no change expected

All runtime (host, status bar, deep link, command, debug API) keys off
`isP2pCarrier` and the settings keys, not the layout shape. If type checking
demands nothing, this file stays untouched in the commit — a deliberate
containment check.

### B3. Tests

- `tests/client/drive-carrier-settings.ts` Test 4b (P2P layout):
  - top-level items = carrier row (first) + group + page, in that order;
  - `groupHeadings === ["P2P (experimental)"]`, `pageNames === ["Advanced"]`;
  - beginner group rows exactly = Direct P2P link / Pair / This vault;
  - Advanced page rows exactly = Backbone / TURN URL / TURN username /
    TURN credential / P2P network check / Debug mode;
  - 3-option carrier dropdown check and the cloudflare/drive dormancy checks
    unchanged.
- `tests/client/p2p-settings-surface.ts`:
  - helpers gain `p2pBeginnerRows(tab)` and `p2pAdvancedRows(tab)`
    (page items); section 1's "only the P2P group" check becomes the
    full-shape check (row + group + page);
  - section 3 wiring: pair action + peer row from the group, network check
    from the Advanced page;
  - section 2 (TURN persistence) now drives the rows from the Advanced page;
  - dormancy checks unchanged.
- No other suite touches the P2P layout; the 127-suite run gates the commit.

### B4. Docs

- `qa/p2p-spike/runbook.md`: prerequisites describe the new layout — pairing
  button on the main P2P screen; *Debug mode* and *P2P network check* in the
  **Advanced** sub-page; TURN fields in the Advanced sub-page.
- `docs/p2p/feasibility.md` §5: layout note updated (hybrid beginner/advanced).
- This plan file: Milestone A marked shipped.

### B5. Gate + release

tsc + 127 suites + build + 3 guards + `lint:changed` → commit → push
`p2p-implementation` → tag `2.1.1-drive.14` → release **Latest, not
pre-release** (PAT still valid) with the four assets → **user runs the
device legs on `.14`** (runbook §0–§9).

### B6. After the user's report

Feasibility §6 (T0.1–T0.5 evidence from the run) + §7 gate call (GO /
degraded / NO-GO per platform) — written **before** `.15` ships.

---

## Milestone C — Phase 1: `P2pCarrier` core (T1.1–T1.7), one release at the end

Same task set and build order as locked in the previous plan round; the
Milestone-B layout is the substrate for its T1.3 settings completion.
Full specs: `docs/p2p-plan.md` §9 Phase 1.

1. **T1.1 frame protocol** — `src/p2p/frame.ts`: sync/awareness/control
   frames; blob & snapshot frames stubbed until Phase 3; pure codec,
   unit-tested immediately.
2. **T1.4 test infra (early slice)** — `FakePeerConnection` (in-memory
   loopback with injected loss/delay/drops).
3. **T1.2 composite carrier** — `p2pCarrier.ts`, `peerLink.ts`, `ice.ts`,
   `routingPolicy.ts`, `docRegistry.ts` (§4.2.3), `mergedAwareness.ts`;
   real carrier contract (`origin === "carrier"`, `status`/`synced`);
   backbone adapter `null | Drive | CF` live (A1/A2); new `p2pBackbone`
   store key; "P2P + None is a legal final state — vault created locally".
4. **T1.3 settings completion** — on the Milestone-B layout:
   - **Advanced page**: Backbone row becomes the real control
     (None / Cloudflare Worker* / Google Drive, §8 copy, `*` recommended
     first per A1) → existing Drive/CF setup sections surface when chosen;
     **cellular data saver (A4)** row (backbone on mobile data, on by
     default);
   - **Beginner section**: *Rotate vault secret* (re-issue codes) row;
   - wizard first screen: "How will your devices find each other?"
     (default: pairing, no servers; backbones offered as optional add-ons
     with the §4.6 trade-offs);
   - status-bar copy per §4.10 (already built, unchanged).
5. **T1.5 fuzz** — `p2p-fuzz` (fixed seeds, ~6 s budget,
   `drive-carrier-fuzz` pattern): link churn, duplicate two-path delivery,
   mid-transfer restarts, secret rotation mid-session; invariants =
   convergence, no lost local edit, receipt honesty.
6. **T1.6 STUN refresh (B4)** — re-gather on network change + ≤ 1×/24 h;
   registry offer written only when the candidate changed.
7. **T1.7 network-change triggers (A3)** — foreground / network-return /
   Wi-Fi↔cellular ⇒ backbone poll + background direct attempt; plus the
   `docs/sync-contract.md` receipt subsection from §4.10.

**Exit (per plan):** two desktop instances sync live over a direct link
with backbone `None`; backbone on ⇒ same scenarios pass with fallback;
toggle matrix green. Plus: full regression (127 + new suites) green, tsc,
build, 3 guards, `lint:changed` → commit → push → tag `2.1.1-drive.15` →
release **Latest** (manual, PAT) → user re-tests on devices.

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| Page navigation is unfamiliar on phones for the advanced rows | Beginner path (pairing + status) needs no navigation at all; runbook points at the Advanced page for TURN/diagnostics. Verified on the phone during the `.14` gate legs. |
| A group + a page + a bare top-level row is a new mix in this tab | The CF layout already mixes groups and pages; unit tests pin the exact top-level order and the per-container row inventories. |
| Phase 1 is large (carrier contract, CRDT registry, fuzz) | Test-first build order; each task lands with its tests green before the next. |
| Gate evidence pending while C builds | Legs run on `.14` in parallel with C's early tasks (T1.1/T1.4 need no device); the gate call is written before `.15` ships regardless of outcome. |
| Old PAT still live (release automation) | Manual release route; revoke reminder in the `.14` and `.15` bodies. |

### Deviations carried / closed

- **Closed:** `.12` always-visible group (superseded by carrier-gating in
  `.13`); `.13` single flat group (superseded by the hybrid section layout
  in `.14`).
- **Open until T1.2:** no `p2pBackbone` store key (Backbone row stays a
  disabled placeholder through `.14`).
- **Open:** no styles.css changes (declarative rows/pages use built-in
  Obsidian styles) — unchanged.
- **Open:** manifest stays `2.1.1`, `isDesktopOnly: false`, tag scheme
  `2.1.1-drive.N` — unchanged.
