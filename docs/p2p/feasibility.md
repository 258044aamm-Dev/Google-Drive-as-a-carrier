# Phase 0 — P2P feasibility (working notes)

Status: **rig complete, CI-level evidence green, device legs pending.**
This is the Phase 0 gate document from `docs/p2p-plan.md` §Phase 0. Fill in the
device measurements from `qa/p2p-spike/runbook.md` before the gate call.

- Branch: `p2p-implementation`
- Devices available (2026-10-03): one desktop + one Android phone. **No second
  desktop and no iOS device** — the plan's desktop×2 and desktop+iOS matrix legs
  are deferred; see "Documented gaps".

## 1. What the spike must prove

Per plan §Phase 0: two Obsidian instances open a raw WebRTC data channel
(signalling by a manual two-code exchange — offer code, then answer code — no service), and real Yjs
state converges over it. Exit criterion: desktop direct = go (assumed); each
mobile platform = go / degraded / no-go.

## 2. What is built (the rig)

All of it is dev-only, gated behind the debug setting, and removed from
`onunload`. It is a measurement harness, not a user feature.

| File | Role |
| --- | --- |
| `src/p2p/spikeOffer.ts` | base64url, SDP trimming (first `m=application` section only), candidate counting, `YAOS-P2P1:` code build/parse |
| `src/p2p/spikeLink.ts` | `RTCPeerConnection` wrapper: pre-gather (1.5 s timeout), text channel = control frames, binary channel = Yjs frames |
| `src/p2p/spikeYjs.ts` | Yjs sync over the binary channel; y-protocols 1.x byte-compatible framing |
| `src/p2p/spikeHost.ts` | UI-free state machine (idle → awaiting-peer/connecting → connected), log, ping, TURN overrides |
| `src/settings/P2pSpikeModal.ts` | in-app panel ("P2P spike panel (dev)"): anchor/join/Yjs test/ICE overrides/log — plain DOM, works on Android |
| `src/main.ts` | wiring: `obsidian://yaos?action=p2p-pair&code=…` deep link → join view; command; `window.__YAOS_P2P_DEBUG__` (DevTools surface, mirrors the host API) |
| `src/settings/settingsTab.ts` + `settingsStore.ts` + `main.ts` (P2P parts) | **"P2P (experimental)" settings group** (plan §8 surface, T1.3 pulled forward): carrier row, honestly-disabled backbone options (Phase 1), persisted TURN fields → spike host, one-peer "This vault" row, *Pair another device* button, *P2P network check* action, §4.10 status-bar copy. Always visible in this test build; the dev-only command/DevTools entry stays debug-gated. |

Pairing code: `YAOS-P2P1:<vaultId>:<vaultSecret>:<b64url(trimmedSDP)>`.
The QR encodes the **deep link** (URL-encoded code), so a camera scan goes
straight to the join view.

## 3. CI-level evidence (already green, 2026-10-03)

`tests/client/p2p-spike-offer.ts` (48 checks) and
`tests/client/p2p-spike-yjs.ts` (12 checks) run in CI with no WebRTC:

- **Code + trim + b64url**: format, 4-segment split, colon-free fields,
  byte-for-byte SDP survival, QR capacity (< 2.5 KB for a 22-char vaultId +
  64-char secret + real offer), trim correctness (junk lines dropped,
  candidates kept in gathered order, idempotent), candidate-type counting.
- **Yjs protocol convergence** over an in-memory wire (the exact framing the
  link will carry): empty↔empty, pre-pairing state transfer, both directions,
  interleaved concurrent edits converge, re-pairing with a fresh peer carries
  the full state (the offline-resume leg of T0.4 at protocol level).

Full suite: **126/126 green** (124 pre-existing + 2 new); `npm run build`
green. This proves the protocol and the code format. It does **not** prove
WebRTC on real devices — that is the runbook's job.

## 4. Technical findings (cost of the spike, kept for Phase 1)

1. **`Y.encodeStateAsUpdate(doc, sv)` takes the ENCODED state vector
   (`Uint8Array`), not a decoded `Map`** (yjs 13.6.29; y-protocols passes raw
   bytes through). Passing a Map corrupts the diff and throws
   "Unexpected end of array". `spikeYjs.ts` documents this at the call site.
2. **y-protocols 1.0.7 frame format**: `[type: varUint][payload:
   varUint8Array]`, type 0 = step1, 1 = step2, 2 = update. Writers always emit
   the type even for an empty payload, so "send the reply only when the peer
   is missing state" must be gated on `encodeStateAsUpdate(doc, sv).length`,
   not on the frame length.
3. **An empty Yjs state vector encodes to 1 byte (`[0x00]`), not 0** — the
   handshake frame for two empty docs is exactly `[0, 1, 0]`.
4. **`synced` flag semantics**: set when the peer's state vector is fully
   covered locally (after sending the step-2 reply) or when any step2/update
   is applied. "Synced on first message" is wrong: in a content-side/
   fresh-side pairing the content holder would never flag synced.
5. **jiti trap (CI only)**: direct `lib0/*` subpath imports from `src/`
   interact badly with the test runner's jiti loader (a module-level
   pre-built Error constant is thrown at runtime with an import-time stack —
   very misleading). `spikeYjs.ts` therefore uses a self-contained LEB128
   codec for the envelope and only yjs's public API for payloads. Irrelevant
   on device (no jiti), relevant to any future CI test that touches lib0.
6. **Deep-link form** (corrects plan §T0.3, which wrote
   `obsidian://yaos/p2p-pair?code=…`): the registered handler is
   `registerObsidianProtocolHandler("yaos", …)` with
   `action === "p2p-pair"`, i.e.
   **`obsidian://yaos?action=p2p-pair&code=<urlencoded-code>`**. The plan doc
   has been corrected in place.

## 4b. Correction (drive.17): pairing needs the answer back

Drive.11–.16 shipped a pairing code that held only the creator's offer. WebRTC
cannot connect from an offer alone: the offering side must also apply the
joiner's answer (ICE credentials, DTLS fingerprint). Evidence, same machine:

- Real Chromium 148: offer only → `connecting` forever, no channel; with the
  answer → `connected`, channel open.
- aiortc (spec implementation): the same.

Fix: the joiner now shows an **answer code** (`YAOS-P2P1-ANS:<vaultId>:<offerId>:<b64url(sdp)>`);
the creator pastes it (*Step 2*). `offerId` is the ICE ufrag of the creator's
offer, so an answer for an older code is refused. Proof script:
`node qa/p2p-spike/handshake-proof.mjs` (real `P2pSpikeHost` ×2 in headless
Chromium: offer-only stays closed, two-way opens, Yjs converges both ways,
ping resolves). CI uses `tests/mocks/fakeRtc.ts`, which opens a channel only
after the answer is applied. Limit that remains: a later reconnect (new
addresses) needs signalling again — a backbone mailbox is the planned answer.

Also fixed in drive.17: `ping()` never settled (its promise was dropped on
the pong), so `__YAOS_P2P_DEBUG__.ping()` hung.

## 5. Documented gaps (by choice, not by accident)

- **T1.3 settings surface (plan §8 shape, wizard, drive.16):**
  "P2P (experimental)" is a **carrier option** in the
  "Sync carrier (experimental)" dropdown. The P2P surface is visible
  **only while the P2P carrier is selected**: the tab is the carrier row,
  a navigable **"P2P (experimental)" home page** (a status card — the
  single source of link state: dot + one line, RTT / last seen when linked
  — plus the **pairing wizard**: role buttons *Create a pairing code* /
  *Join with a code*, only the selected step visible; Create = generate
  code + labeled box + copy + QR block (appears once rendered), Join =
  labeled field + join; *Disconnect* only while linked — the pairing path,
  in the settings UI, no overlay) and a navigable **Advanced sub-page**
  (Backbone, TURN URL/username/credential, P2P network check as a visible
  *Run check* button, Debug mode). With any other carrier the whole P2P
  surface is dormant (no P2P screen, no status-bar item, pairing links not
  accepted). The P2P engine **starts on demand** (drive.16: a carrier
  switch no longer needs a plugin reload for the P2P surface — the sync
  runtime still does). The pairing deep link opens the home page on the
  Join step with the field pre-filled (fallback: the dev panel, which is
  unchanged and keeps all dev controls — Live Yjs test, ICE overrides,
  log). TURN fields are fully functional and persisted. The backbone
  options are **disabled placeholders** — the composite carrier (T1.2) and
  backbone adapters still belong to Phase 1 proper, after the gate.
  Cellular data saver (A4), secret rotation, and the wizard first screen
  are not included.
- **No CDP on phones**: the panel is the mobile control surface; DevTools
  (`__YAOS_P2P_DEBUG__`) is desktop-only.
- **One data channel only**, mid fixed by the code; no renegotiation.
- **`vaultSecret` in the code is carried but NOT yet used for
  authentication** — Phase 1 (plan §4.2.3 registry + secret).
- **No CI link-level loopback** (real `RTCPeerConnection` in Node is not
  available); the yjs test drives `SpikeYjs` directly over an in-memory wire.
  A `FakePeerConnection` lands in Phase 1 (T1.4).
- **iOS untested** (no device) — follow-up; same panel/protocol apply.
- **Cross-network legs need the phone on cellular** (single phone, single
  desktop). The plan's laptop–laptop and phone–phone legs are untested here.

## 6. Measurement status (T0.1–T0.5)

| Test | Question | Status |
| --- | --- | --- |
| T0.1 | Raw data channel between two Obsidian instances | CI: protocol ✓ · **device: pending** (runbook §3) |
| T0.2 | Pairing with the two codes (offer + answer); code size + QR capacity | CI: format/size ✓ · **device: pending** (runbook §4, real phone scans) |
| T0.3 | QR → phone camera → deep link → join view | **device: pending** (runbook §5) |
| T0.4 | Real Yjs sync: edit/restart/offline-resume, convergence + timing | CI: protocol convergence ✓ · **device: pending** (runbook §6) |
| T0.5 | NAT traversal matrix (STUN-only outcomes) | **device: pending** (runbook §7; same-WiFi first, then 4G) |

## 7. Gate call (fill after runbook)

- Desktop direct: **__** (go / degraded / no-go) — expected go.
- Android: **__** — expected go or degraded (mobile NATs are stricter;
  TURN override in the panel covers the worst case, which is a "degraded"
  signal, not a no-go, since Phase 1 ships a backbone fallback).
- iOS: **deferred** (no device) — mark pending, not no-go.

No-go rule (unchanged): a platform that cannot open a direct link in any
network tested gets backbone-assisted mode + a diagnostic row in settings;
the architecture is not changed for it.
