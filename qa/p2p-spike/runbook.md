# Phase 0 P2P spike — device runbook

Companion to `docs/p2p/feasibility.md`. Executes T0.1–T0.5 on real devices:
**one desktop + one Android phone** (the only hardware available — see the
feasibility doc's documented gaps).

## 0. Prerequisites (once per machine)

1. Check out `p2p-implementation`, `npm ci`, `npm run build`.
2. Desktop: in the test vault, enable the built plugin from the branch (or
   copy `dist/main.js` into the vault's `.obsidian/plugins/<plugin>/` as
   usual for this repo's dev workflow).
3. Android: same plugin build, installed in the phone's test vault
   (copy `main.js` + `manifest.json` over the existing install, restart
   Obsidian).
4. **Both devices**: **Settings → YAOS → "Sync carrier (experimental)"** →
   select **P2P (experimental)**. On `.16+` the P2P page starts working
   **immediately — no plugin reload needed** (the P2P engine starts on
   demand; a reload is only needed for the sync-runtime side of a carrier
   switch). The settings tab becomes the P2P screen: the carrier row on top
   (switching back is one tap away), then a navigable
   **"P2P (experimental)"** home page — a **status card** (dot + one line:
   no link / awaiting / connecting / linked · RTT · last seen / error) and
   the **pairing wizard**: two role buttons — **Create a pairing code**
   (on this device) and **Join with a code** (from the other device) — with
   only the selected step visible. Create: *Generate pairing code* → labeled
   code box + *Copy code* + a **QR** block ("Scan this with the other
   device's camera" + *Copy deep link*), the QR appearing only once
   rendered. Join: a labeled field + *Join* (enabled once you've pasted a
   code). **Disconnect** (full-width) appears below the card only while
   linked. Plus a navigable **Advanced** sub-page holding *Backbone*
   (Phase 1), the *TURN* fields (the primary way to set a relay, T0.5),
   *P2P network check* (a real *Run check* button), and *Debug mode*. With
   any other carrier selected the P2P surface is fully dormant (no P2P
   screen, no P2P status-bar item, pairing links are not accepted).
5. **Optional, for the command palette + DevTools**: turn **Debug mode** on
   (Settings → YAOS → the P2P screen's **Advanced** sub-page) and restart
   Obsidian. With the P2P
   command palette offers **"P2P spike panel (dev)"** (command id
   `p2p-spike-panel`) and the desktop DevTools console exposes
   `window.__YAOS_P2P_DEBUG__` (`generate()`, `join(code)`, `state()`,
   `log()`, `ping()`, `yjsEdit(t)`, `yjsRead()`, `setTurn(t)`,
   `clearTurn()`, `close()`). The phone has **no CDP** — the panel is its
   whole surface. While a link is active, the bottom status bar shows
   `P2P · linked` (+ RTT) / `P2P · awaiting pair` / `P2P · connecting`.

### Where pairing lives (drive.16+)

Pairing (generate / join / disconnect) is on the **P2P home page** (the
user surface — settings UI, no overlay), in the **pairing wizard**: pick
**Create a pairing code** (this device generates the code + QR) or
**Join with a code** (paste a code from the other device). The dev
**panel** keeps the same pairing controls plus its dev-only sections (Live
Yjs test, ICE overrides, log) and is reached via Debug mode → command
palette. The pairing deep link opens the **P2P home page** on the **Join
step with the field pre-filled** (and starts the P2P engine on demand — no
reload needed); on a build/Obsidian where the settings tab cannot be opened
programmatically it falls back to the dev panel with the join pre-filled —
record which one you see.

### Panel tour (both devices, identical)

- **Status row**: `phase · ice · conn · channel · RTT`. `phase` walks
  `idle → awaiting-peer` (anchor) / `connecting` (joiner) `→ connected`.
  Success looks like: `phase: connected · ice: connected · conn: connected ·
  channel: open`.
- **1 · Anchor**: *Generate pairing code* → code + size line (`code N chars /
  N bytes · candidates N (host X, srflx Y, relay Z) · gathering complete|timeout`)
  + code textarea + *Copy code* + a **QR** of the deep link + a *Deep link
  (manual / no QR)* disclosure with *Copy deep link*.
- **2 · Joiner**: paste `YAOS-P2P1:…` → *Join* → the panel shows an **answer
  code** (`YAOS-P2P1-ANS:…`, *Copy answer*). Send it back to the anchor.
- **2b · Anchor, paste the answer**: paste `YAOS-P2P1-ANS:…` → *Connect*.
  Only now does the link open (WebRTC needs both sides' details).
- **3 · Live Yjs test**: shared textarea (replicates when connected),
  *Send random edit*, *Copy converged text*, and a yjs status line
  (`synced · local edits N · remote edits N · N bytes received`).
- **4 · ICE overrides**: TURN url/username/credential → *Apply TURN*
  (takes effect on the **next** generate/join). *Clear overrides* to go back
  to STUN-only (Google + Cloudflare STUN defaults).
- **Log** (bottom `<pre>`): timestamped events — candidate gathering,
  ICE/connection transitions, frame errors.

**Record for the feasibility doc**: the size line after each generate,
`state().link` transition times (from log timestamps), and any error
strings.

## 1. Reset between legs

*Close link* in the panel (or *Disconnect* on the P2P home page, or
`__YAOS_P2P_DEBUG__.close()` on desktop), watch the phase return to
`idle`/`closed`, then re-generate. Generating
re-gathers candidates, so a stale offer never leaks into the next leg.

## 2. Leg ordering (cheap → expensive)

Run in this order; each leg ends with *Close link* and a row in the results
table (§8):

1. §3 — T0.1 same Wi-Fi, desktop anchor + Android joiner (basic channel).
2. §4 — T0.2 same Wi-Fi: code-size + real QR scan (phone camera).
3. §5 — T0.3 deep-link chain, same Wi-Fi.
4. §6 — T0.4 Yjs edit/restart/offline-resume, same Wi-Fi.
5. §7 — T0.5 cross-network (phone on cellular), STUN-only, then with TURN
   override if available.

**Paste-code fallback (standing rule)**: whenever a QR/deep link fails
(camera focus, Obsidian cold start, browser interception), fall back to
*Copy code* → paste into the joiner panel. Note which path failed and why —
that is T0.3 evidence either way.

## 3. T0.1 — raw data channel (same Wi-Fi)

Goal: both Obsidian instances reach `channel: open` with no code changes.

1. Desktop: **P2P home page** (Settings → YAOS → P2P (experimental); the dev
   panel works too) → wizard: **Create a pairing code** → **Generate
   pairing code**. Note the size line (panel) / the code box + QR (page).
2. Android: copy the code (clipboard share, or retype the prefix + scan the
   text off the desktop screen if clipboard sharing is flaky) → P2P home
   page (or dev panel) → wizard: **Join with a code** → paste → **Join**.
   The phone now shows **Step 2: an answer code** → *Copy answer* and send
   it to the desktop (any messenger / clipboard sync / email to yourself).
2b. Desktop: under **Step 2: paste the answer** paste it → **Connect**.
   (Drive.16 and older had no answer step, so their links could never open.)
3. Expected: joiner `phase: connecting` → `connected`; anchor the same;
   `ice: connected`, `channel: open` within seconds. Log shows gathered
   candidate types.
4. **Ping** (both sides): record RTT. *Ping ×5* for spread.
5. Close link. Repeat 2× to catch flakiness.

**Pass**: 3/3 pairings reach `open`, ping RTT < ~50 ms on the same LAN.

## 4. T0.2 — two-code pairing + code size/QR

Goal: the two codes (offer, then answer) are enough (no service), record the
size of both, and check that the QR of the offer is actually scannable on the
phone. Offer ≈ 0.9 KB and answer ≈ 0.7 KB in a desktop Chromium run
(`qa/p2p-spike/handshake-proof.mjs`).

1. Desktop: **Generate** (record the size line — CI already proves the
   format; this records the *real* offer from a real Chromium: candidate
   count, byte count).
2. Sanity: the QR (page QR block, or panel) encodes
   `obsidian://yaos?action=p2p-pair&code=<urlencoded>` — on the page,
   *Copy deep link* and confirm the shape; in the panel, expand the *Deep
   link* disclosure.
3. Android (camera app, **not** Obsidian yet): point at the desktop screen's
   QR. Expected: the phone's browser/OS offers to open Obsidian → the
   deep link fires → Obsidian opens the **P2P home page** (Settings → YAOS →
   P2P (experimental)) on the **Join step with the field pre-filled** with
   the code (the engine starts on demand — no reload). (Fallback build
   behavior: the dev panel opens with the join pre-filled — record which.)
4. Tap **Join** (or it joins straight through — record which).
5. If the scan fails: note *why* (focus, screen size, Obsidian not
   foreground, `obsidian://` blocked by a browser) and use the paste
   fallback. A failed scan is data, not a failure of the leg.
6. Close link. Regenerate once more with a long vaultId-style setup is NOT
   needed — CI covers synthetic sizes; just record the real one.

**Pass**: pairing with the two codes works; QR scan outcome recorded (scan
worked / degraded to paste + reason); code byte count recorded.

## 5. T0.3 — deep-link proof (Android)

Goal: `QR → camera → obsidian://yaos?action=p2p-pair&code=… → Join step pre-filled on the P2P home page`.

This is the same chain as §4 step 3–5, but judged separately:

- **Handler fired** = Obsidian foregrounded on the P2P home page (or the
  dev panel, fallback) on the Join step with the join field pre-filled. (A
  `Notice` "P2P
  pairing link is missing a code." means
  the handler fired but the param didn't survive — a real bug, file it.)
- Record: cold start vs warm start of Obsidian, which intermediary the OS
  used (direct intent / browser), time from scan to pre-filled join field.
- The plan doc's older form (`obsidian://yaos/p2p-pair?code=…`) is **wrong**;
  the handler is `action=p2p-pair` (feasibility doc §4.6). Do not test the
  old form.
- iOS leg: **not testable** (no device) — mark pending in the feasibility
  doc, do not extrapolate from Android.

**Pass**: handler fires on ≥1 of 3 scan attempts; failures characterized.

## 6. T0.4 — real Yjs sync over the link

Goal: convergence + timing, then offline-resume.

1. Pair (§3). When `connected`, section **3 · Live Yjs test** is live on
   both devices.
2. **Edit A→B**: type a sentence on the desktop; watch the Android textarea
   update (polls every 700 ms). Record perceived delay (subjective: instant /
   <1 s / laggy) and the yjs status line counters (`remote edits` should
   climb on Android).
3. **Edit B→A**: same from the phone.
4. **Concurrent**: type on both at once for ~10 s; then **Copy converged
   text** on both and compare (paste both into a note and diff, or compare
   lengths + eyeball). Must converge to the same text.
5. **Send random edit** a few times from one side; verify arrival.
6. **Offline-resume**:
   a. Note the converged text (copy it).
   b. Android: **Close link** (then optionally quit Obsidian entirely for
      the stronger variant).
   c. Wait 30 s. Android: re-open the panel → paste a **fresh** code
      (desktop: *Generate* again) → **Join**.
   d. The previous text must be present on the Android side (full state is
      carried by the handshake — CI proves this at protocol level; this
      proves it end-to-end).
   e. Keep typing on the desktop; verify the phone catches up.
7. Close link.

**Pass**: both directions < ~1 s perceived; concurrent edit converges;
re-paired peer has the pre-restart text.

## 7. T0.5 — NAT traversal matrix (the decisive leg)

Goal: STUN-only outcomes across networks. Same-WiFi only ever shows
host/srflx; cellular adds the realistic NAT pair.

Defaults are STUN-only (`stun:stun.l.google.com:19302`,
`stun:stun.cloudflare.com:3478`) — **do not** set a TURN override until the
STUN-only attempt has genuinely failed.

Matrix (desktop anchor; phone joiner; note the candidate types in each
generate's size line — the anchor's — and the ICE outcome):

| # | Desktop network | Phone network | Expectation |
| --- | --- | --- | --- |
| a | Wi-Fi (home/office) | same Wi-Fi | host/srflx — baseline (done in §3) |
| b | Wi-Fi | **4G/5G** | STUN srflx↔srflx; symmetric NATs may fail → record |
| c | 4G hotspot (phone tethering the desktop is fine, roles may flip) | Wi-Fi | reverse of b |

If a STUN-only attempt fails (phase `connecting` stuck, `ice: failed`):

1. Record the exact failure (log lines, ice state).
2. Retry **with a TURN override**: enter URL/username/credential in the
   **Settings → P2P screen → Advanced sub-page → TURN** fields (persisted;
   takes effect on the next pairing — the panel's *Apply TURN* writes the
   same fields) → re-generate on the anchor → re-join. Relay candidates
   then appear (`relay N > 0` in the size line).
3. A success **only with relay** = "degraded" for that network pair — this
   is the planned outcome that motivates the backbone fallback; it is not a
   no-go.
4. *Clear overrides* when done.

BD network note: if both legs are on BD networks, record that explicitly —
the plan asks for BD outcomes "if possible".

**Pass**: leg (a) works; leg (b)/(c) outcome recorded (connected STUN-only /
degraded via relay / failed with log).

## 8. Results table (copy into `docs/p2p/feasibility.md` §7 / gate call)

| Leg | Date | Net pair | Candidates (anchor) | ICE path | Pair time | RTT (×5) | QR scan | Yjs conv. | Resume | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T0.1 | | | | | | | n/a | n/a | n/a | |
| T0.2 | | | | | | | ok / paste+why | n/a | n/a | |
| T0.3 | | | | | | | (scan detail) | n/a | n/a | |
| T0.4 | | | | | | | n/a | ok / detail | ok / detail | |
| T0.5a | | | | | | | n/a | n/a | n/a | |
| T0.5b | | | | | | | n/a | n/a | n/a | |
| T0.5c | | | | | | | n/a | n/a | n/a | |

Gate call after the table: desktop **go/degraded/no-go**, Android
**go/degraded/no-go**, iOS **pending (no device)**.

## 9. Cleanup

- *Close link* on both devices.
- TURN overrides cleared if used.
- Debug mode can stay on until the gate call (the panel is the evidence
  surface); turn it off afterwards if the vault is shared.
