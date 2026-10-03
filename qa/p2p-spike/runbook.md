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
4. **Both devices**: open **Settings → YAOS** and scroll to the
   **"P2P (experimental)"** group (bottom of the tab). It is always visible
   in this test build — the *"Pair another device (QR + code)"* row opens the
   spike panel, and the *TURN* fields here are the primary way to set a relay
   (T0.5).
5. **Optional, for the command palette + DevTools**: turn **Debug mode** on
   (same settings tab, above the P2P group) and restart Obsidian. Then the
   command palette offers **"P2P spike panel (dev)"** (command id
   `p2p-spike-panel`) and the desktop DevTools console exposes
   `window.__YAOS_P2P_DEBUG__` (`generate()`, `join(code)`, `state()`,
   `log()`, `ping()`, `yjsEdit(t)`, `yjsRead()`, `setTurn(t)`,
   `clearTurn()`, `close()`). The phone has **no CDP** — the panel is its
   whole surface. While a link is active, the bottom status bar shows
   `P2P · linked` (+ RTT) / `P2P · awaiting pair` / `P2P · connecting`.

### Panel tour (both devices, identical)

- **Status row**: `phase · ice · conn · channel · RTT`. `phase` walks
  `idle → awaiting-peer` (anchor) / `connecting` (joiner) `→ connected`.
  Success looks like: `phase: connected · ice: connected · conn: connected ·
  channel: open`.
- **1 · Anchor**: *Generate pairing code* → code + size line (`code N chars /
  N bytes · candidates N (host X, srflx Y, relay Z) · gathering complete|timeout`)
  + code textarea + *Copy code* + a **QR** of the deep link + a *Deep link
  (manual / no QR)* disclosure with *Copy deep link*.
- **2 · Joiner**: paste `YAOS-P2P1:…` → *Join*.
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

*Close link* in the panel (or `__YAOS_P2P_DEBUG__.close()` on desktop),
watch the phase return to `idle`/`closed`, then re-generate. Generating
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

1. Desktop: panel → **Generate pairing code**. Note the size line.
2. Android: copy the code (clipboard share, or retype the prefix + scan the
   text off the desktop screen if clipboard sharing is flaky) → panel →
   paste → **Join**.
3. Expected: joiner `phase: connecting` → `connected`; anchor the same;
   `ice: connected`, `channel: open` within seconds. Log shows gathered
   candidate types.
4. **Ping** (both sides): record RTT. *Ping ×5* for spread.
5. Close link. Repeat 2× to catch flakiness.

**Pass**: 3/3 pairings reach `open`, ping RTT < ~50 ms on the same LAN.

## 4. T0.2 — embedded-offer pairing + code size/QR

Goal: the code alone is enough (no second channel, no service), and the QR
is actually scannable on the phone.

1. Desktop: **Generate** (record the size line — CI already proves the
   format; this records the *real* offer from a real Chromium: candidate
   count, byte count).
2. Sanity: the QR in the panel encodes
   `obsidian://yaos?action=p2p-pair&code=<urlencoded>` — expand the *Deep
   link* disclosure and confirm the shape.
3. Android (camera app, **not** Obsidian yet): point at the desktop screen's
   QR. Expected: the phone's browser/OS offers to open Obsidian → the
   deep link fires → Obsidian opens with the **join view pre-filled** with
   the code (the code is visible in section 2 of the panel).
4. Tap **Join** (or it joins straight through — record which).
5. If the scan fails: note *why* (focus, screen size, Obsidian not
   foreground, `obsidian://` blocked by a browser) and use the paste
   fallback. A failed scan is data, not a failure of the leg.
6. Close link. Regenerate once more with a long vaultId-style setup is NOT
   needed — CI covers synthetic sizes; just record the real one.

**Pass**: pairing from code alone works; QR scan outcome recorded (scan
worked / degraded to paste + reason); code byte count recorded.

## 5. T0.3 — deep-link proof (Android)

Goal: `QR → camera → obsidian://yaos?action=p2p-pair&code=… → join view`.

This is the same chain as §4 step 3–5, but judged separately:

- **Handler fired** = Obsidian foregrounded with the join view open and the
  code pre-filled. (A `Notice` "P2P pairing link is missing a code." means
  the handler fired but the param didn't survive — a real bug, file it.)
- Record: cold start vs warm start of Obsidian, which intermediary the OS
  used (direct intent / browser), time from scan to join view.
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
   **Settings → P2P (experimental) → TURN** fields (persisted; takes effect
   on the next pairing — the panel's *Apply TURN* writes the same fields) →
   re-generate on the anchor → re-join. Relay candidates then appear
   (`relay N > 0` in the size line).
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
