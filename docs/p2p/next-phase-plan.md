# Next-phase plan — section-based P2P UI (Milestone B) + Phase 1 core (Milestone C)

Date: 2026-10-03. Status: **Milestones A, B and B2 SHIPPED** — A
(carrier-gated P2P settings, `2.1.1-drive.13`, commit `7789952`), B
(section-based P2P UI, `2.1.1-drive.14`, commit `d7ef1a8`) and B2 (P2P
settings redesign, `2.1.1-drive.15`, commit `1fdaeaa` — includes the BRAT
version fix, manifest 2.1.15), all verified Latest. **Next: Milestone B3
(P2P page wizard redesign + desktop "not ready" fix → `.16`, manifest
2.1.16), then Milestone C (Phase 1 core → `.17`, manifest 2.1.17).** The
Phase 0 gate legs (run on `.15`/`.16` per the user's schedule) feed the
feasibility evidence + gate call before `.17` ships.
This plan grew out of the maintainer's 2026-10-03 direction: *"The current
P2P UI should be section-based, beginner-based, and advanced-based"* and
*"Now implement the next phase."*

Decisions locked via interactive questions (2026-10-03, round 10):

| Question | Decision |
|---|---|
| Structure | **Hybrid:** the beginner section sits directly on the P2P screen (immediate pairing path); the advanced section is a **navigable "Advanced" sub-page** (same page pattern the Cloudflare layout already uses). Carrier row stays on top of everything. |
| Content split | **Beginner** = Direct P2P link (plain explanation), Pair another device (QR + code), This vault (peer status). **Advanced** = Backbone (optional), TURN URL/username/credential, P2P network check, Debug mode. |
| Release strategy | **UI rework first as `2.1.1-drive.14`** (Latest) so the section design is verified on both devices; Phase 1 core then ships as **one final release** (Latest), same work stream. (Superseded in round 12: the UX rework became Milestone B2 → `.15`; Phase 1 is now `.16`.) |
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

---

## Release hygiene — manifest version scheme (fixes the BRAT warning), from `.15`

**Problem (user report, 2026-10-03):** updating between test builds with BRAT
(`.11→.12`, `.12→.13`) shows a version-mismatch **warning** (non-blocking).
Root cause: every test release ships `manifest.json` with
`version: "2.1.1"` — only the git tag changes — so BRAT sees no version
change (the Obsidian convention is that the manifest version increases per
release).

**Decisions locked (user, 2026-10-03):**
- Manifest version = **`2.1.<N>` for drive build `.N`**, starting at
  **`.15` → `2.1.15`**, then `2.1.16`, … — the build number is readable off
  the version; strictly increasing so git-based updaters see a clean
  upgrade; sits in the 2.1.x line (no collision with upstream 2.1.1).
- **Tag convention `2.1.1-drive.N` stays unchanged** — tags are the
  human-readable series; the mapping is stated in each release body.

**Execution (first step of the Milestone B2 release commit for `.15`):**
1. `manifest.json` → `version: "2.1.15"`.
2. Safety facts already verified: the plugin's update check nags only when
   installed < upstream-latest (`compareSemver === -1`) — 2.1.15 is newer
   than upstream, so no nag; **no test pins `"2.1.1"`**;
   `manifest.version` is metadata only (telemetry header, status rows,
   server ack tracking).
3. `.15` release body documents: "manifest version now tracks the build
   (2.1.N); earlier builds were all 2.1.1, which is why git-based updaters
   showed a harmless mismatch warning — it no longer appears."
4. Full regression gate as always (metadata-only change, but the 127+ suites
   still gate the commit).

**No patch release for `.14`** — the user is running the Phase 0 gate legs
on it; the `.14 → .15` BRAT update (2.1.1 → 2.1.15) is the first clean bump.
Scheme continues for all later test/phase releases.

---

## Milestone B2 — P2P settings UX rework, release `2.1.1-drive.15` (manifest 2.1.15) — **shipped (drive.15)**

**User report (2026-10-03, round 12):** (1) rows don't show whether they are
clickable; (2) "Pair another device (QR + code)" opens an **overlay** instead
of a settings sub-page; (3) the page overall "is not user-friendly and does
not look good."

**Execution note (2026-10-03, round 14):** one deviation from the steps
below — `P2pSpikeModal` was kept **unchanged** instead of being trimmed to
dev-only: it is the deep-link fallback surface (when the settings tab cannot
be opened programmatically) and the runbook's CDP/panel surface. The pairing
flow on the home page and the panel share the same spike host, so both stay
functional and honest.

**Decisions locked via interactive questions (2026-10-03, round 12):**

| Question | Decision |
|---|---|
| Pairing page scope | **Beginner pairing flow only**: generate code + QR, join with a code, live link status. Dev-only tools (live Yjs test, event log, ICE/TURN overrides) stay in the Debug-mode-gated panel. |
| Build approach | **Custom-built P2P screens** (custom `SettingPage`s): the main P2P page is a designed page (status card, prominent pairing section, peer line); the **Advanced page stays native declarative** with buttonified rows. |
| CSS | **Scoped CSS for the P2P surface only** — every rule under `.yaos-p2p-*` classes (lifts the earlier "no styles.css" deviation, strictly scoped; zero-regression constraint still applies). |
| Release | **Redesign first as `.15`** (manifest `2.1.15` — the BRAT fix lands here), **Phase 1 as `.16`** (manifest `2.1.16`). (Superseded in round 15: the B2 visual review produced Milestone B3 → `.16`; Phase 1 is now `.17`, manifest `2.1.17`.) |

**API facts (recon-verified, obsidian.d.ts 1.13+):**
- `SettingDefinitionPage.page?: () => SettingPage` — a custom imperative
  sub-page; "called each time the page is opened." `SettingPage` has
  `containerEl`, `display()` (clears + re-renders on open), `hide()`
  (cleanup).
- **No programmatic page-navigation API** → the pairing flow lives on the
  **main P2P page** (not a separate nav entry); the pairing deep link opens
  the settings tab and lands on that page with the code pre-filled.
- `SettingDefinitionAction` is a whole-row click — it looks like plain text
  at rest, which is exactly complaint (1). `SettingDefinition.render`
  (per-row imperative DOM) and `desc: DocumentFragment` give real
  affordances where rows stay declarative.

**Target design (carrier = P2P selected):**

```
Settings > YAOS
├─ [Sync carrier (experimental)]            (declarative row, on top)
├─ P2P (experimental)     ← custom main page (navigable entry)
│    ├─ status card: ● linked · 34 ms · last seen 10:21
│    │               (also: awaiting a peer / connecting / no link yet)
│    ├─ Pair another device  (collapsible pairing section — expanded by
│    │   default while there is no link, collapsible once linked)
│    │    ├─ [ Generate pairing code ]  →  code text · [Copy] · QR (canvas)
│    │    ├─ join with a code: [ input ] [ Join ]
│    │    └─ live line: phase · ICE · RTT   (+ [ Disconnect ] when linked)
│    └─ This vault: peer summary line
└─ Advanced                ← declarative page (rows unchanged)
     ├─ Backbone (optional) · TURN URL / username / credential
     ├─ P2P network check   → visible real button (render hook)
     └─ Debug mode
```

- **Dev panel** (`P2pSpikeModal`): trimmed to the dev sections (live Yjs
  test, event log, ICE/TURN overrides) — its pairing sections move to the
  page. Still opened by the debug-gated command palette entry.
- **Deep link** `p2p-pair&code=…`: set a pending code, open the YAOS
  settings tab, main page picks the code up in `display()` → join input
  pre-filled, pairing section expanded. Runtime API
  `app.setting.openSettingTab` is not in the vendored d.ts → typed cast +
  try/catch with a Notice fallback (deep link on the phone is a manual
  verification item in the `.15` release check).
- **Copy**: user-facing text drops "feasibility / test build" jargon.
- **Clickability**: real `<button>`s on the page; the network-check row gets
  a visible button; every remaining row is clearly a control, a button, or
  informational text.

**Implementation (all additive/rework within the P2P surface):**
1. `src/settings/P2pPairingFlow.ts` (new) — controller: `generate()` →
   code + QR text, `join(code)`, `disconnect()`, `state()` passthrough,
   `render(container)` for the pairing DOM (extracted from
   `P2pSpikeModal`, reusing the `qrcode` canvas rendering). Pure logic apart
   from `render` → unit-testable without a DOM.
2. `src/settings/P2pHomeSettingPage.ts` (new) — `SettingPage` shell:
   `display()` renders the status card + pairing section + peer line under
   `.yaos-p2p-*` classes, 1 s state poll while displayed, `hide()` cleanup,
   `host.takePendingP2pPairCode()` pickup (exactly once).
3. `src/settings/P2pSpikeModal.ts` — trim to the dev sections.
4. `src/settings/settingsTab.ts` — p2p branch:
   `[carrierRow(), p2pHomePageDef, p2pAdvancedPage]` (the main page def
   carries `page: () => new P2pHomeSettingPage(host)`); network-check row →
   render-hook button; copy fixes; host interface gains
   `takePendingP2pPairCode()`.
5. `src/main.ts` — deep link: pending code + open settings tab (fallback
   Notice); dormant-carrier branch unchanged; dev command unchanged.
6. `styles.css` — new `.yaos-p2p-*` block (status card, dots, buttons, QR
   wrap, code, state colors). A guard check that every P2P selector is
   scoped under `.yaos-p2p-` (added alongside the existing guard scripts).
7. `tests/mocks/obsidian.ts` — add the `SettingPage` base class so page
   shells can be constructed in tests.
8. **Tests**: drive-carrier-settings Test 4b → top level = carrier row +
   "P2P (experimental)" page (factory, no declarative items) + "Advanced"
   page (items unchanged); dormancy unchanged. p2p-settings-surface adapted
   (group → page factory; TURN/Advanced wiring kept). New
   `tests/client/p2p-pairing-flow.ts`: controller logic (generate code/QR
   text, join → host.join, state → card text mapping, pending-code pickup
   exactly once, disconnect → host.close, no link → no QR). Full regression
   gates the commit.
9. **Docs**: runbook (the P2P page is the surface — the phone flow is now
   settings-only, no CDP and no overlay; dev panel = debug tools only),
   feasibility §5 layout note, this plan.

**Gate + release:** tsc + full regression + build + 3 guards (+ scoped-CSS
check) + `lint:changed` → commit → push → tag `2.1.1-drive.15` → release
**Latest** (manual, PAT). Body notes: manifest version now `2.1.15`
(the BRAT warning fix — earlier builds were all `2.1.1`) + the UX rework.
Then: **user reviews the look on both devices** (desktop + Android).

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| Custom page re-renders on every tab `update()` | `display()` is idempotent (clear + rebuild); the flow controller is stateless w.r.t. DOM; manual check covers the reload flow. |
| `openSettingTab` not in the vendored d.ts | Typed cast + try/catch + Notice fallback; deep link verified manually on the phone in the `.15` release check. |
| No DOM in the test environment | Controller logic is pure (unit-tested); DOM verified in the release check on both devices. |
| CSS leak into the rest of the plugin | Strict `.yaos-p2p-*` scoping + a guard that enforces it; the 127+ suite regression gates everything else. |
| User expectation on the visual design | Review on both devices before Phase 1 (`.16`) builds on top; copy/layout tweaks are cheap follow-ups within the same release scheme. |

**Deviations updated:** "no styles.css changes" — **lifted for the P2P
surface only** (scoped `.yaos-p2p-*`, user decision round 12). All other
deviations unchanged.

---

## Milestone B3 — P2P page wizard redesign + desktop "not ready" fix, release `2.1.1-drive.16` (manifest 2.1.16) — **shipped (drive.16)**

**Execution notes (2026-10-03, round 16):** (a) the release gate also
required restoring two dev-only dependencies that the regression gate
depends on but that were never declared — `tsx` (root devDependency, used
by `tests/server/snapshot-r2-runner.ts` via `npx --no-install tsx`) and
`server/node_modules` (miniflare via wrangler) — so a clean checkout's
gate is green without manual installs; (b) contract parity (the
`release-compatibility-matrix` suite pins package.json === manifest
version + a versions.json entry) is now maintained by bumping
**package.json together with the manifest** (`2.1.16`) and adding the
released `2.1.15` + current `2.1.16` entries to `versions.json` — the
`.15` commit had bumped only the manifest, which that suite only catches
when the gate runs *after* the bump.

**User report (2026-10-03, round 15):** screenshot of the `.15` page on the
phone + "redesign this screen with user-friendly and better UI/UX" and
"this screen content is not showing on desktop".

Screenshot defects identified (all in the B2 page):
- **Disconnect visible while not linked** — bug: the button is hidden via
  the `hidden` attribute, which theme CSS can override (any author
  `display` rule beats the UA `[hidden]` rule). Must be shown only when
  `connected`.
- **Empty mystery boxes** — the QR container (bordered rounded box) renders
  even when no QR exists; the code/join textareas have no labels and their
  placeholders are nearly invisible; both show resize grips.
- **Copy code enabled with no code** — clicking does nothing silently.
- **Redundant wording** — the status card and the "This vault" line repeat
  the same "awaiting a peer" message.
- **Jargon on a beginner page** — the `phase: … · ice: … · RTT: …` line at
  the bottom.
- Small left-aligned pill buttons (hard to tap on the phone).

**Desktop root cause (verified in code, round 15):** the desktop shows the
page stuck on *"The P2P link is not ready — reload the plugin."* even after
"reloading".
- The spike host is created **once, in `onload()`**, and **only if the P2P
  carrier was already selected when the plugin loaded**
  (`if (isP2pCarrier(this.settings)) new P2pSpikeHost(...)`).
- Switching the carrier in the dropdown **only persists the value** + a
  "Reload the plugin …" notice (the carrier `setControlValue` handler) — it
  never creates the host. The tab re-renders live, so the P2P page
  *appears*, but `getP2pSpikeHost()` returns `null` → the fallback text.
- Repro chain: desktop updated to `.15` (BRAT reload happened while the
  *old* carrier was selected) → user selects the P2P carrier → page
  appears, host dormant → any "reload" that is not a real plugin reload
  (reopening the settings tab) can never fix it. Dead end.
- **Fix: lazy spike host.** `getP2pSpikeHost()` creates the host on demand
  when the P2P carrier is selected (idempotent; also starts the status-bar
  item + 1 s timer lazily). The pairing deep-link handler uses the same
  getter, so the QR chain works without a reload. Eager `onload` creation
  stays. No more "reload the plugin" dead end on the P2P surface. The
  sync-runtime carrier switch still requires a reload (unchanged; the
  carrier row desc already says so).
- **Hardening (same milestone):** the `onload()` P2P block is wrapped in
  try/catch (visible Notice + log; a P2P failure must not abort the rest of
  `onload()` — the protocol-handler registration comes after it); the page
  `display()` becomes idempotent (clears any prior timer on re-entry) and
  catches its own render errors into a visible in-page line (never a silent
  blank); the misleading "reload the plugin" text is gone.
- **Diagnostic (non-blocking, ask the user):** one desktop DevTools console
  screenshot to rule out an `onload` exception *before* the P2P block as an
  alternative cause. The lazy host makes the page work regardless.

**Decision locked (ask_user, round 15):** **role-based wizard** — first pick
"Create a pairing code" or "Join with a code", then only that flow is shown.

### Target design (carrier = P2P, page open)

```
┌ P2P (experimental) ──────────────────────────────────────────┐
│ ● No P2P link yet. Pair a device below to get started.       │ ← status card
│   (when linked: ● Linked · 24 ms · last seen 13:41:02)        │   dot + one line
│                                                               │
│  ┌─────────────────────────┐ ┌───────────────────────────┐   │
│  │ Create a pairing code   │ │ Join with a code          │   │ ← role picker:
│  │ (on this device)        │ │ (from the other device)   │   │   two big tap
│  └─────────────────────────┘ └───────────────────────────┘   │   targets
│                                                               │
│  ┌ only the selected step is visible ──────────────────────┐ │
│  │ CREATE:                                                  │ │
│  │  [ Generate pairing code ]          full-width button   │ │
│  │  (before generation: nothing else is shown)             │ │
│  │  Pairing code                      after generation:    │ │
│  │  ┌────────────────────────────────┐                     │ │
│  │  │ YAOS-P2P1:… (read-only,        │                     │ │
│  │  │ no resize grip)                │                     │ │
│  │  └────────────────────────────────┘                     │ │
│  │  [ Copy code ]   enabled only while a code exists       │ │
│  │  ┌───────────┐   Scan this with the other device's      │ │
│  │  │    QR     │   camera app — + small [Copy deep link]  │ │
│  │  └───────────┘   (QR block hidden until the QR is ready)│ │
│  │                                                          │ │
│  │ JOIN:                                                    │ │
│  │  Pairing code from the other device                      │ │
│  │  ┌────────────────────────────────┐                     │ │
│  │  │ YAOS-P2P1:…                    │                     │ │
│  │  └────────────────────────────────┘                     │ │
│  │  [ Join ]   disabled until the field is non-empty       │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  (when linked: [ Disconnect ] appears below the status card)  │
└───────────────────────────────────────────────────────────────┘
```

Behaviour notes:
- **Wizard role is page-local state** on the flow controller: default
  "create"; a pairing deep link forces "join" + pre-fills the field (the
  T0.3 chain lands directly on the Join step). The 1 s refresh must never
  reset the role.
- **Visibility is a pure, DOM-free function** —
  `flow.view(state) → P2pWizardViewModel` decides: active role; Disconnect
  visible (only `connected`); code panel visible (only after generation);
  QR visible (only once rendered); Copy enabled (code exists); Join enabled
  (field non-empty). Unit-tested without a DOM.
- **All show/hide via a scoped `.yaos-p2p-hidden { display: none !important; }`
  class** (plus the `hidden` attribute, plus `disabled` on buttons) — the
  B2 `[hidden]`-override bug class is structurally impossible now.
- **Removed from the user page:** the technical `phase · ice · RTT` line
  (still in the dev panel + status bar) and the standalone "This vault"
  line (the card is the single source of state; the peer summary merges
  into the card when linked).
- **While linked, generating a new code ends the current link** (existing
  reset behaviour) — a small hint under the Generate button says so.
- **CSS:** replace the B2 page block with the wizard classes
  (`.yaos-p2p-wizard/-role-grid/-role-btn(.active)/-step/-label/-btn--full/
  -qr-caption/-hint/-hidden`); full-width buttons capped ~520 px and
  centered; `resize: none` on the code textareas; 2-column role grid that
  collapses to 1 column on narrow screens. All under `.yaos-p2p-*` (the
  scoping guard stays green).

### Implementation steps
1. `src/p2p/spikeHost.ts` — unchanged.
2. `src/settings/P2pPairingFlow.ts` (v2): role state (`setRole`;
   prefill → role "join"); pure `view(): P2pWizardViewModel`; `mount()` v2
   renders the wizard per view model (role grid, both steps, Disconnect
   slot, QR caption); `update()` applies the view model (class toggles +
   `disabled`); Copy/Join disabled states; QR wrap hidden until the canvas
   is ready; keeps `lastGeneratedCode/DeepLink`, `consumeJoinPrefill`,
   `disconnect`, the unmount-safe contract, and all existing behaviour
   tests.
3. `src/settings/P2pHomeSettingPage.ts` (v2): status card updated (linked
   text merges the peer summary); hosts the wizard; **no** standalone peer
   line, **no** technical live line; `display()` idempotent (clears any
   prior timer first) and wrapped in try/catch that renders a visible
   error line (never a silent blank); the "reload the plugin" text is gone.
4. `src/main.ts`: **`ensureP2pSpikeHost()`** — carrier-gated lazy creation
   (host + status-bar item + 1 s timer; idempotent; try/catch → visible
   Notice + plugin log, error remembered); `getP2pSpikeHost()` delegates to
   it (returns null only when the carrier is not P2P or creation failed);
   the deep-link handler uses the lazy getter (dormant branch only for
   non-P2P carriers); the existing eager `onload()` P2P block is wrapped in
   try/catch so a P2P failure cannot abort the rest of `onload()`.
5. `styles.css`: B2 page block replaced by the wizard block (all
   `.yaos-p2p-*`); guard unchanged.
6. `src/settings/settingsTab.ts`: no shape change (same page factory; the
   carrier-switch notice stays — the sync runtime still needs a reload).
7. `tests/client/p2p-pairing-flow.ts` (v2): keep the behaviour tests
   (generate records code/deep link; join trims; blank join no-op; prefill
   exactly once + switches role to "join"; disconnect clears; unmount-safe
   update) + new view-model tests (Disconnect only when connected; code
   panel hidden before generation; QR hidden until ready; Copy disabled
   before a code; Join disabled when empty; role survives `update()`).
8. `tests/client/p2p-settings-surface.ts` + `drive-carrier-settings.ts`:
   layout shape unchanged (verify); add a factory check that the page
   renders the (now-unreachable-in-practice) no-host branch without
   throwing.
9. `main.ts` lazy-host logic stays ~15 lines (no main.ts unit harness
   exists — verified via the device-leg round trip; risk row below).
10. Docs: runbook (page = wizard; **no reload needed** to use the page;
    T0.3 deep link lands on the Join step with the code filled in; dev
    panel unchanged), feasibility §5 (page description + lazy host), this
    plan (C renumbered below), release body.
11. Full gate → **release `.16`** (manifest `2.1.16`, tag
    `2.1.1-drive.16`, 4 assets, Latest, API-verified).

### Version renumbering (consequence of inserting B3)
`.16` was reserved for Milestone C (Phase 1) → **Milestone C now ships as
`.17` (manifest 2.1.17)**. The Milestone C section below is updated
accordingly. Mechanical — the BRAT scheme is just monotonic `2.1.<N>`.

### Risks
| Risk | Mitigation |
|---|---|
| Lazy host vs the "decided once at onload" dormancy contract | Creation is strictly carrier-gated (`isP2pCarrier`); other carriers byte-identical; the sync-runtime decision stays onload-only. |
| `onload` throws before the P2P block on the desktop (unruled-out alternate cause) | try/catch makes a P2P failure visible; user provides a one-time desktop DevTools console screenshot; the lazy host makes the *page* work regardless. |
| Wizard role state across Obsidian page re-entry | Role lives on the flow controller; `display()` idempotent; a prefill deterministically re-forces the "join" role. |
| Theme CSS overrides (the B2 `[hidden]` bug class) | Visibility via scoped `.yaos-p2p-hidden` `display:none !important` + `disabled` attributes; the view model is unit-tested. |
| No unit harness for `main.ts` lazy creation | Kept ~15 lines; verified in the `.16` device round trip (page works after a fresh carrier switch, without reload). |
| User expectation on the visual design | Review on both devices after `.16`; copy/layout tweaks are cheap follow-ups within the scheme. |

**Deviations:** unchanged from B2 (scoped CSS allowed; dev panel unchanged).

---

## Milestone C — Phase 1: `P2pCarrier` core (T1.1–T1.7), one release at the end (`2.1.1-drive.17`, manifest 2.1.17)

Same task set and build order as locked in the previous plan round; the
Milestone B2/B3 screens (custom P2P main page + Advanced page) are the
substrate for its T1.3 settings completion. Full specs:
`docs/p2p-plan.md` §9 Phase 1.

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
4. **T1.3 settings completion** — on the Milestone B2/B3 screens:
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
toggle matrix green. Plus: full regression (128 + new suites) green, tsc,
build, 4 guards, `lint:changed` → commit (manifest `2.1.17` per the
release-hygiene scheme) → push → tag `2.1.1-drive.17` → release **Latest**
(manual, PAT) → user re-tests on devices.

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
