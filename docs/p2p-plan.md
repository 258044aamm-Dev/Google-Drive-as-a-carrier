# P2P sync plan ("Anytype-like")
Status: **proposal — plan only, no code yet** (2026-10-03).

Scope: a **P2P carrier** for YAOS whose **default mode is pure
device-to-device — no Google Drive, no Cloudflare, no server of any kind**.
Optionally, the user can enable a **backbone** (Google Drive or Cloudflare
Worker) through the settings UI for auto-discovery, offline catch-up, and
durable attachments/snapshots. Devices pair with each other by **pairing code
or QR code**.

> Written for the `google-drive-carrier` fork. The existing Cloudflare and
> Google Drive carriers keep working exactly as today; the P2P carrier is a
> third option.

## Decisions (maintainer, 2026-10-03)

| Question | Decision |
|---|---|
| Default P2P behaviour | **Pure P2P only** — no Drive, no Cloudflare, no hosted service. The author hosts nothing. |
| Backbones | **Optional, user-chosen in the settings UI**: `None (default)` / `Google Drive` / `Cloudflare Worker`. |
| Pairing | **Pairing code OR QR code** (same content; QR is scanned by the phone's camera/any QR app and opens Obsidian via the already-registered `obsidian://yaos/…` deep link). |
| Attachments & snapshots in pure P2P | **Replicated between online devices** (push on upload, pull on miss, over the direct links). |
| Access control | **Pairing-code possession = membership** (Anytype-style). A random **vault secret** inside the code is the key; rotating it re-issues codes and cuts off a leaked member. No passphrase in pure mode. |
| Key rotation (Drive-shared vaults) | **New vault ID + import** (proven Drive-carrier UX). |
| P0 backlog vs P2P | **P0s first**: SYNC-01, SYNC-02, ISSUE-68 land before P2P Phase 1. |
| Who implements | **The agent, in this workspace**, phase by phase on a new branch; maintainer reviews; maintainer's phones for real-device legs. |

---

## 1. Goals and non-goals

### Goals

1. **Local-first, no conflicts** — already true (files on disk + one
   vault-wide Yjs CRDT, CRDT merge, never conflicted copies).
2. **Pure P2P by default**: with nothing but each other, two or more devices
   sync notes, temp files (attachments), snapshots, and live presence
   (cursors) directly, in milliseconds.
3. **Zero infrastructure**: the author hosts nothing; plugin users deploy
   nothing; the only "service" a pure vault uses is the airwaves between the
   user's own devices.
4. **Pairing by code or QR**: adding a device is "scan this / paste this",
   same UX class as the existing setup codes — no terminal, no account.
5. **Optional backbones, honestly positioned**: Drive or Cloudflare, enabled
   in settings, add auto-discovery, offline catch-up, and durable
   attachments/snapshots for users who want them — never required.
6. **Publishable for anyone**: a stranger can create a vault, pair their
   phone with a QR, and (Phase 5) hand the pairing code to another person.

### Non-goals (for now)

- No Kademlia/DHT swarm discovery (≤ ~10 peers per vault; a registry map in
  the shared document suffices).
- No hosted relay, no hosted TURN, no third-party bootstrap services (the
  pure default trusts no external party).
- No in-app QR *scanner*: Obsidian plugins cannot access the mobile camera;
  QRs are **displayed** in-app and **scanned externally** (phone camera / any
  QR app → `obsidian://` deep link). (This direction already exists in the
  product: `PairDeviceModal` + `registerObsidianProtocolHandler("yaos", …)`.)
- No `.obsidian` sync, multi-vault, sharded bodies — per the main backlog.
- No block-level attachment delta sync (whole-file blobs, as today).
- No background sync on phones (OS suspends the app; unchanged).
- No behaviour change for existing Cloudflare/Drive users.

---

## 2. Current state of this fork (what we build on)

| Piece | Where | Relevance to P2P |
|---|---|---|
| `SyncTransport` interface | `src/sync/transport.ts` | The carrier seam. `P2pCarrier` is a composite transport: direct links + optional backbone (itself any `SyncTransport`). Engine untouched. |
| Google Drive carrier | `src/drive-carrier/` | Reusable as an **optional backbone**: OAuth, Yjs-as-files, request-budget polling, AES-256-GCM passphrase encryption, content-addressed attachments, snapshots. |
| Cloudflare Worker carrier | `server/` + y-partyserver | Reusable as an **optional backbone**: real-time room, ticketed auth, DO+SQLite persistence, R2. |
| `BlobStoreClient` / `SnapshotBackend` | `src/sync/blobSync.ts` / `src/snapshots/snapshotBackend.ts` | Existing plug-in seams — the pure-P2P attachment/snapshot plane plugs in here; `BlobSyncManager`/`SnapshotService` otherwise untouched. |
| QR + deep-link plumbing | `src/settings/PairDeviceModal.ts` (`qrcode` dep), `main.ts` (`registerObsidianProtocolHandler("yaos", …)` → `SetupLinkController`) | QR display + `obsidian://yaos/…` receiving already exist and are proven; P2P pairing reuses both. |
| Yjs 13 + awareness | `yjs`, `y-protocols` | The direct-link protocol = standard `y-protocols/sync` + `awareness` over a data channel (`y-webrtc` as reference). |
| Disk/CRDT reconciliation, conflict artifacts, safety brakes, tombstones | `src/sync/`, `src/runtime/` | Carrier-agnostic; P2P inherits the whole safety contract. |
| QA harness + analyzers | `qa/` | CDP two-device scenarios and invariant analyzers are carrier-agnostic; add P2P scenarios + a fuzz suite. |

Platform facts (unchanged from earlier drafts, they drive the design):

- **Desktop** (Electron): full WebRTC. **Mobile**: WebView WebRTC exists but
  must be proven per platform in Phase 0 (biggest risk).
- **CGNAT phones** (common on BD mobile data) can't be *called*; only
  outbound works. Two CGNAT phones can't reach each other directly without a
  relay/TURN. Consequences for the pure default are handled in §4.6 and the
  wizard guidance — honestly, not hidden.
- WebRTC data channels: ordered, reliable per connection, DTLS-encrypted in
  transit; Yjs deltas (KBs; MBs at bootstrap) are well within them.

---

## 3. What Anytype actually does (and what we copy)

| Anytype property | Adoption in YAOS |
|---|---|
| Each device is a full data holder | Already true (disk + IndexedDB). Keep. |
| Objects are CRDTs; merge, never conflict | Already true (Yjs). Keep. |
| Direct device-to-device sync when reachable | **New** — WebRTC data channel + Yjs sync/awareness. |
| Relay layer for unreachable peers | **Optional, user-deployed/owned** — the user's own Drive folder or Cloudflare Worker as *backbone*; off by default. |
| DHT for peer discovery | **Skip** — a peer-registry **map inside the shared Yjs document** (carrier-agnostic, §4.3). |
| Space access = key possession | **Yes** — pairing code carries a random **vault secret**; members present it in the hello handshake; rotation cuts off leaked members. |
| Relays can't read content | Pure mode: nothing is ever stored anywhere (DTLS in transit only). Backbones: Drive passphrase / Worker-is-yours trust models, both already implemented. |
| Go/WASM any-sync SDK | **Skip** — JS-native WebRTC in the plugin. |

---

## 4. Target architecture

### 4.1 Overview

```
                 ┌─────────────────────────────────────────────────────┐
                 │  Device A (Obsidian: laptop / phone)                │
                 │                                                     │
                 │  VaultSync ── SyncTransport ── P2pCarrier           │
                 │  (CRDT,        (seam:       ┌── PeerLink 1 ─────────┼── WebRTC data
                 │   disk,         status/sync,│    ICE + STUN         │    channels
                 │   editor)       origin,     │    (+opt. TURN)       │  (direct, DTLS)
                 │   bindings)    awareness)   │── PeerLink 2 ─────────┤
                 │                             │    ...                │
                 │                             └── Backbone (optional) ┼── None (default)
                 │             Yjs sync + awareness + blob/snapshot    │  | Google Drive
                 │             frames over the link                    │  | Cloudflare WS
                 └─────────────────────────────────────────────────────┘  (user's own;
                                   ▲                                      auto-discovery,
                                   │ direct links between all paired      offline catch-up,
                                   │ devices (mesh; N-1 links per device  durable store)
                                   │
                 ┌─────────────────┴──────────────┐
                 │  Shared Yjs document (vault)   │  ← the peer registry lives HERE:
                 │  · notes (Y.Text per file)     │    __yaos.peers[deviceId] =
                 │  · blob refs, tombstones       │    { offer, vaultSecret, platform,
                 │  · __yaos.peers (NEW, small)   │      lastSeen, … }   (LWW per device)
                 │  · __yaos.meta (schema + secret)│
                 └────────────────────────────────┘
```

New code: **`src/p2p/`** (client only — there is no server component for
pure P2P). Reused: `PairDeviceModal` (QR), the `obsidian://yaos/…` handler,
the Drive/CF transports as backbone adapters, `BlobStoreClient`/
`SnapshotBackend` seams, the whole engine.

### 4.2 Components

1. **`P2pCarrier`** — composite `SyncTransport`:
   - a set of **`PeerLink`s** (one per paired device, mesh), plus
   - an optional **backbone transport** (`null` by default; or the existing
     `DriveTransport` / Cloudflare y-partyserver provider, selected in
     settings). Any `SyncTransport` qualifies as a backbone — that is the
     whole adapter surface.
   - Remote updates arrive via links and/or backbone; all applied with
     `origin === carrier` (engine contract in `transport.ts`).
   - `wsconnected` = at least one link up **or** backbone reachable.
   - `synced` = local state vector dominated by the union of (backbone's
     latest known vector ∪ every known peer's vector).
   - `awareness` = merged awareness (union over links, deduped by clientId).
2. **`PeerLink`** — one `RTCPeerConnection` + one data channel per peer;
   runs `y-protocols/sync` (step1/step2/update), `awareness`, and the
   control/blob frames of §4.5. ICE (STUN by default, user-supplied TURN
   optional), ICE restart on failure, backoff, health via RTT ping (~10 s,
   3 missed → down).
3. **Peer registry inside the document (NEW)** — `__yaos.peers` (a Yjs map,
   one entry per `deviceId`):
   ```
   { offer: <trimmed SDP, LWW per device>,
     platform, addedAt, lastSeenAt,
     blobInventory: <top-N hashes> (for pull routing, optional) }
   ```
   - Every device writes its own entry on start and when its offer changes
     (STUN candidate changed, app start, network change) — **no periodic
     heartbeats** (zero poll-budget impact; presence granularity is
     link-up / recently-seen / unknown).
   - Because the entry is CRDT content, it propagates through **every** path:
     direct links in pure mode, Drive files / CF room when a backbone is on.
     A newly bootstrapped device learns **all** peers from the first peer it
     reaches, then dials each one using their stored offers.
   - **`__yaos.meta`** carries the **vault secret** (random 16 B, created
     with the vault) and schema version. `hello` must present the secret;
     mismatch → reject. **Rotation = "re-issue codes"**: remaining members
     get fresh codes; a leaked member's links stop being accepted. (Pure-P2P
     equivalent of the Drive passphrase, without encrypting local files.)
   - Size discipline: entries bounded (~2 KB incl. offer), LWW, bounded
     device count (~16; beyond that, oldest evicted with a notice).
4. **Backbone adapters (optional)** — thin:
   - **`DriveBackbone`** = existing `DriveTransport` (join flow = the
     existing Drive wizard; passphrase for folder encryption is offered when
     the backbone is first attached, per the existing "encryption at folder
     creation" rule).
   - **`CfBackbone`** = existing Cloudflare transport (join flow = the
     existing claim/setup-code flow).
   - Backbone roles: auto-discovery (doc entries ride the backbone), offline
     catch-up (durable files/room), durable attachments/snapshots (existing
     blob/snapshot backends), faster re-connection for CGNAT pairs.
5. **Routing policy** — per peer: `direct-healthy → prefer direct` /
   `direct-failed → backbone (if any) else "peer unreachable"` /
   `direct-degraded → backbone + background ICE restart`. Both paths may be
   open during handover; Yjs dedupes by update id (§4.8). In pure mode with
   a down peer there is simply no path — the UI shows the peer as
   unreachable and nothing else is claimed.

### 4.3 Pairing: code and QR

**Content** (same for code and QR):
```
YAOS-P2P1:<vaultId>:<vaultSecret>:<b64(anchorOffer)>
```
- `anchorOffer` = the generating device's **pre-gathered, trimmed WebRTC
  offer** (own deviceId's ICE ufrag/pwd, DTLS fingerprint, at most 2
  candidates: LAN + one STUN public candidate; ~0.8–1.3 KB → total code
  ≈ 1.2–1.7 KB).
- **QR**: `PairDeviceModal` renders
  `obsidian://yaos/p2p-pair?code=<urlencoded>` (the deep link carries the
  code; the modal also shows the raw code text below the QR). Scanned by the
  phone's camera or any QR app → Obsidian launches → the existing
  `registerObsidianProtocolHandler("yaos", …)` handler routes it into the
  pairing flow. Phone-pointed-at-laptop-screen scanning works (no in-app
  camera needed).
- **Code**: paste into the "Join with pairing code" field. The code is
  ~1.5 KB: the supported mediums are **QR and paste** (copying text between
  your own devices by any means); the UI labels it accordingly and does not
  promise manual character-by-character entry.

**Flow** (new device B joining existing device A):
1. A: "Pair another device" → modal (QR + code) — generates a fresh offer
   (STUN pre-gather) on demand.
2. B: scans/pastes → `hello` handshake (vaultId, **vaultSecret**, schema) →
   sets A's offer as remote description → B's answer goes straight to A's
   candidate address (no signalling server exists — the answer is delivered
   to the address *inside the code*; see §4.6 for when that address is
   reachable).
3. Sync step1/step2: A (or its doc) bootstraps B with the full document.
4. B writes its own `__yaos.peers` entry (its own offer) → all devices learn
   B → B dials every other peer with stored offers → mesh completes
   (partially, immediately, where NATs allow).

**Access control** (decided): code possession = membership. The vault secret
in the code is the key; no other password exists in pure mode. "Remove a
member" = **rotate the vault secret** (panel action; remaining devices get
fresh codes; the removed member can no longer connect — their historical CRDT
contributions remain, same limit as git).

### 4.4 Connection lifecycle (per peer)

```
 unknown ──learned from doc (pairing, bootstrap, or registry)──► negotiating
  negotiating:
    · deterministic roles: lexicographically-smaller deviceId is ALWAYS the
      answerer-side dialer → exactly one side initiates (no offer storms)
    · dial using stored offer (pairing code first, then doc entry)
    · ICE success ──────────────────────────────► syncing-direct
    · ICE timeout (default 10 s, configurable) ──► unreachable
 syncing-direct:
    · sync + awareness + blob/snapshot frames over the data channel
    · heartbeat lost 3× ────────────────────────► renegotiating (ICE restart)
    · ICE restart fails ────────────────────────► unreachable
 unreachable:
    · backbone (if enabled): sync via backbone + registry via doc
      (backbone keeps data flowing; direct retried in background,
      backoff 1 min → 10 min)
    · pure mode: UI shows "unreachable — same Wi-Fi? TURN? backbone?"
      (wizard guidance, §4.6). No claim is made about the peer's state.
  peer entry tombstoned / evicted ──────────────► unknown
```

**Reachability is never deletion**: a stale peer can cause no delete, no
tombstone, no overwrite — registry entries are presence metadata only;
content changes flow through CRDT exclusively (unchanged engine rules).

### 4.5 Wire protocol (data channel framing)

Binary, length-prefixed (4-byte big-endian) frames, type byte + payload:

| Type | Payload | Notes |
|---|---|---|
| `0x01` sync step 1 | `Y.encodeStateAsVector` | on link open, both directions |
| `0x02` sync step 2 | `Y.encodeStateAsUpdate(doc, remoteSV)` | bootstraps a fresh device from the dominant peer |
| `0x03` sync update | `Y.encodeStateAsUpdate` | continuous; batched ≤ 64 KB/frame (split larger) |
| `0x04` awareness | awareness buffer | cursors; latest-wins |
| `0x05` control hello | `{deviceId, platform, schema, vaultSecret}` | identity + key gate before any sync |
| `0x06` control ping/pong | `{t}` | RTT/health |
| `0x07` control bye | `{}` | clean close |
| `0x08` blob have-query | `{hash}` / `{hash, ack}` | "who has attachment X?" (pure-P2P pull discovery) |
| `0x09` blob chunk | `{hash, seq, bytes}` | attachment transfer, ≤ 128 KB/chunk, resumable by seq |
| `0x0A` snapshot ref/chunk | `{snapId, …}` | snapshot transfer (same chunking) |
| `0x0B` control error | `{code, msg}` | e.g. `secret_mismatch`, `update_required` |

Schema admission: the single shared schema version, enforced in `hello`
(`update_required` → clean error, same as today).

### 4.6 Pure-P2P reachability — the honest physics

Without any server, device B can complete pairing/links with device A only
if B can reach the address embedded in A's offer:

| Topology | Pure P2P result |
|---|---|
| Same Wi-Fi / LAN | ✅ works immediately (LAN candidates in the offer) |
| A on a reachable network (public IP, open UDP, office NAT that forwards) | ✅ works cross-network |
| A behind CGNAT (typical phone 4G), no TURN | ❌ B can't reach A — **wizard guidance fires** (§ below) |
| Both behind CGNAT, **user-supplied TURN configured on both** | ✅ via TURN (TURN is user's own choice; the author operates none) |

**Wizard guidance** (the escape hatches the maintainer asked for, in
settings): when a link attempt fails with "address unreachable", the UI
shows the plain-English CGNAT explanation (C1) and then offers, in order:
(1) "connect both devices to the same Wi-Fi and retry";
(2) **enable a backbone — Cloudflare Worker first** (one-click deploy,
real-time push, your account, your data) **with Google Drive second** (no
Cloudflare needed; a few seconds of polling latency) — devices find each
other automatically and catch up even after long offline periods;
(3) "configure TURN" (advanced settings). None of these is forced; pure
mode remains the default and remains fully functional for reachable pairs.
A one-tap **`YAOS: P2P network check`** (B2) is available on this screen
and in the command palette at all times.

Data-path honesty: while a peer is unreachable, **nothing is lost** — local
edits accumulate in IndexedDB and land when any path (direct or backbone)
reconnects. The status bar never claims delivery it can't support (§4.10).

### 4.7 Attachments and snapshots in pure P2P (decided: replicate)

Plugs into the existing seams (`BlobStoreClient` in `blobSync.ts`,
`SnapshotBackend` in `snapshots/`):

- **`P2pBlobStoreClient`**:
  - *Upload*: hash as today (content-addressed, local blob store on disk);
    then **push** the file to online peers via `0x09` frames (bounded
    concurrency, ≤ 10 MB cap and existing size settings apply). Push
    fan-out policy: all currently-syncing peers, best-effort; a peer that
    misses it can still pull later.
  - *Download/miss*: broadcast `0x08 have-query`; first `ack` streams the
    chunks to the requester; verify hash on completion (existing
    verification rules); on completion, opportunistically back-fill other
    online peers (one hop, throttled).
  - With a backbone enabled: backbone blob store is primary (today's
    behaviour); pure-P2P push/pull is the gap-filler for offline periods.
- **`P2pSnapshotBackend`**: snapshots are taken locally (compressed full
  update + blob index, existing format) and **replicated to online peers**
  (chunked `0x0A`). Retention mirrors the Drive rule: all pinned + newest N
  daily (default N=7 locally). `browse snapshots`/restore work unchanged —
  the browse list is the union of local + peers' advertised snapshot refs
  (snapshot refs are small; they ride the doc registry entry or a `hello`
  extension).
- Storage discipline: per-device caps on replicated attachment bytes
  (default = existing attachment cap × 20, configurable); evicted locally by
  LRU of blob refs still referenced by no note.

### 4.8 Duplicate delivery and ordering

Handover windows (link + backbone both open) can deliver the same Yjs update
twice or out of global order. **Safe by construction**: Yjs updates are
idempotent, merge order-independently; `updateTracker`/`ackOrigins` treat
same-origin re-application as a no-op. Blob transfers are idempotent by
hash. No new dedupe machinery; a fuzz rule asserts "same update via two
paths → identical doc".

### 4.9 Deletes, tombstones, safety brakes

Untouched. The engine doesn't know which path delivered an update — only
`origin === carrier` matters (holds for links and backbone alike). A peer
disappearing is never evidence of deletion.

### 4.10 Receipts and status language

New subsection in `docs/sync-contract.md` — "Receipt on the P2P carrier":

- **Pure mode**: "Saved" = **persisted in local IndexedDB** (durable local
  copy). There is no server receipt because there is no server. Per-peer
  direct-link state shown in the "This vault" panel (direct / unreachable).
- **With backbone**: "Saved" adds the backbone's own receipt contract
  (Drive: file stored + size confirmed; CF: existing server-receipt
  contract). Unchanged from those carriers' sections.
- **Permitted claims**: links up (to which devices); local state persisted;
  backbone receipt (when a backbone is on); last known receipt time
  (historical).
- **Forbidden claims**: "another device has your change" (a link can be up
  and the peer's doc stale); a pending-update count; anything about an
  unreachable peer. UI: existing saved state + per-peer dots; nothing more
  precise is honest.

### 4.11 CGNAT toolkit (decided 2026-10-03)

Physics (stated once, then referenced): CGNAT blocks inbound, so a
cross-network CGNAT pair can only sync via a relay, or by direct success
(same LAN / a reachable device / TURN). Four levers:

**A — Make the relay path feel instant**

- **A1 CF-first recommendation** — backbone recommendation order in the
  failure ladder and in settings is Cloudflare → Drive (§4.6, §8).
- **A2 Event-driven polling (Drive backbone)** — a poll that finds fresh
  peer activity (new `lastSeenAt`) or a new update file triggers an
  immediate follow-up poll (≤ 3 s gap). Request-meter bounded: at most 3
  consecutive follow-ups per activity burst, then normal cadence resumes.
  A local edit uploads immediately if the last poll saw a fresh peer.
  Net effect: cross-device latency ≈ one poll, not one interval.
- **A3 Network-change triggers** — Wi-Fi ↔ cellular switch (and app
  resume, as today) ⇒ immediate backbone poll **and** a background direct
  attempt (normal ICE timeout).
- **A4 Cellular data saver** — backbone on mobile data: idle polling slows
  to 60–120 s and a **Sync now** button appears in the header (immediate
  poll + upload). Default on; per-device setting.

**B — Make direct succeed more often**

- **B1 Reachability probe + anchor role** — over any live path, the carrier
  sends `probe-request {candidate}` to a peer; the peer attempts a 1-byte
  connect to that candidate and answers `probe-result {ok, rtt}`. Devices
  reachable from the internet set `anchor: true` (LWW, registry). Pairing
  UI offers **the anchor's QR first** ("this code works from anywhere");
  the "This vault" panel shows an anchor badge per device. Probes at most
  once per 10 minutes per peer.
- **B2 `YAOS: P2P network check`** — one-tap command (the Obsidian-plugin
  analogue of any-sync's netcheck tool): STUN result (public candidate),
  probe result in both directions per known peer, backbone latency (when
  enabled), per-peer direct/relay status, NAT hint (both directions
  blocked ⇒ "likely CGNAT"), exportable via the debug export. Turns "why
  isn't my phone connecting?" into a 10-second answer, for users and for
  support.
- **B3 TURN auto-ICE** — if both peers' registry entries advertise
  `turnConfigured`, the carrier builds the TURN-enabled ICE config
  automatically for that pair; a **Test direct link** button in the panel
  runs one clean attempt and reports the result.
- **B4 STUN refresh** — public candidate re-gathered on network change
  (A3 trigger) and at most once per 24 h; the registry offer is rewritten
  only when the candidate changed.

**C — Honest guidance**

- **C1** First cross-network failure: the plain-English explanation + the
  §4.6 ladder.
- **C2** A 5-minute **"P2P anchor at home"** guide (public IP / Tailscale /
  port-forward on the home network ⇒ the home device becomes the permanent
  anchor for the whole vault).

**D — Deferred, documented only** — **D1** payload E2E encryption
(prerequisite for any future public/third-party relay); **D2** hybrid LAN
bridging (a backbone-connected device relaying for a LAN-only device).

---

## 5. Security and privacy

| Layer | Design |
|---|---|
| In transit (direct) | WebRTC DTLS: confidentiality + integrity, ephemeral keys. |
| In transit (backbone) | WSS + ticket (CF) or Drive OAuth (Drive) — both existing. |
| Access to the vault | **Vault secret** in `hello` (pure mode); backbone tokens as today. Code possession = membership (decided); **rotate = re-issue codes** cuts off a leaked member. UI warns that a pairing code is a full-membership credential. |
| At rest | Pure mode: nothing leaves the devices (local notes are the user's plain files; local IndexedDB is the existing trust boundary — unchanged). Drive backbone: optional passphrase (AES-256-GCM, PBKDF2 600 k, HKDF — existing), offered when the backbone is attached. CF backbone: the Worker is the user's (existing trust model). |
| Peer metadata in the doc | Offers contain public/LAN candidates — visible to vault members (acceptable: members already see each other's edits; with a Drive backbone + passphrase, even this is sealed). Reachability state (anchor flag / probe results, §4.11-B1) has the same visibility class. |
| Author-hosted infrastructure | **None.** No relay, no TURN, no analytics, no logs. |
| Known limit (documented) | A member who had the code before rotation can read their **historical** CRDT copy (same as git history); rotation prevents *future* writes/reads. |

---

## 6. Multi-user sharing (publish for anyone)

- **Pure P2P sharing** works *by construction*: the owner shows the pairing
  QR/code to another person; that person's device pairs, bootstraps, and
  joins the mesh (reachability caveats of §4.6 apply — e.g. the owner's
  device must be reachable from the other person's network, or they meet on
  the same Wi-Fi, or both configure TURN). Revocation = rotate vault secret.
  Phase 5 = wizard copy + "share with a person" screen + rotation UX + docs.
- **Drive-backbone sharing** (second person, different Google account):
  account-level sharing of the `YAOS <vaultId>` folder (owner's app adds the
  member's account as writer; member signs in with the same sign-in method —
  `drive.file` cross-client visibility is a Phase 5 research item, fallback
  = "same sign-in method" wizard hint). Re-key = **new vault ID + import**
  (decided).
- **No accounts system, no user database** — identity stays
  "a device id + a vault secret (+ a Google account only if a Drive backbone
  is used)", consistent with the fork's zero-terminal ethos.

---

## 7. Platform constraints (what we must not pretend away)

- **iOS/Android WebRTC in WebView**: real support, real variance — Phase 0
  gate per platform; a no-go platform runs backbone-assisted mode with a
  diagnostic row "P2P: direct unavailable (WebView)".
- **Phones pause apps in the background**: no background sync (unchanged).
  On resume: reconnect attempts + state-vector catch-up (typically < 1 s of
  transfer for a normal day of edits, if a path exists).
- **CGNAT**: pure-mode phone↔phone pairs across networks need a reachable
  device or TURN — §4.6 guidance; enabling a backbone is the recommended fix
  for that topology (honestly surfaced, never silent).
- **Yjs memory ceiling** (unchanged from the architecture doc); direct links
  don't change it.
- **Mobile bandwidth**: bootstrap of a big vault over 4G can be MBs — step 2
  streams in ≤ 256 KB chunks with progress UI, resumable (state vectors
  re-sent on reconnect). Attachment replication respects the existing size
  cap and concurrency settings.
- **QR capacity**: code ≈ 1.2–1.7 KB → QR v30–40 at M correction fits
  (validated in Phase 0 with the real `qrcode` lib + real scan tests);
  fallback if a future SDP grows past capacity: candidate trimming is
  already the max, next step would be backbone-assisted join message.

---

## 8. Settings UI (the surface the maintainer asked for)

```
Settings > YAOS > Setup > Sync carrier
 ├─ Cloudflare Worker            (unchanged)
 ├─ Google Drive (experimental)  (unchanged as a polling carrier)
 └─ P2P (experimental)           (NEW)
      Backbone (optional):  [ None (default) | Cloudflare Worker* | Google Drive ]
                             (* recommended first on cross-network failure — A1)
      ─ None: "Devices find each other via pairing codes/QR. New devices
              pair with an online, reachable device. Attachments and
              snapshots replicate between online devices."
      ─ Google Drive:  (existing Drive setup section appears; passphrase
        offered at first attach; request-budget settings apply to the
        backbone path)
      ─ Cloudflare:    (existing claim/setup-code section appears)
      TURN (advanced): URL / username / credential   [optional; auto-ICE when both sides have it — B3]
      P2P network check (command): one-tap connectivity report (B2)
      Cellular data saver (backbone on mobile data): [on (default) | off]  (A4)
      This vault:  per-peer panel (device, direct/unreachable dot, last seen)
      Pair another device (QR + code)   ·   Rotate vault secret (re-issue codes)
```

- Choosing **P2P + None** is a legal final state with zero other
  dependencies — the vault is created locally (vault id, secret, device
  entry) and immediately usable on this device.
- Switching backbone on/off later preserves all local state (same switch
  pattern as today's carrier switches).
- The wizard's first screen asks "How will your devices find each other?" —
  default answer **pairing (no servers)**; the backbone choices are
  presented as optional add-ons with the honest trade-offs of §4.6.

---

## 9. Phased plan

Effort = engineer-weeks (agent implements; maintainer reviews + provides
phones for the real-device legs).

### Phase A — P0 prerequisites (before any P2P code) — **DONE 2026-10-03**

Closure evidence landed on `p2p-implementation`. Finding: all three P0
items already had engine-level fixes in the fork upstream of this branch;
Phase A therefore produced the missing **closure evidence**, not new
engine code. Nothing in Phases 0–6 may depend on these bugs being present;
their regressions re-run on the P2P carrier in CI.

- **SYNC-01 (offline delete resurrection)** — fixed upstream, engine step 2
  (`30d333d`): pure policy `src/runtime/reconcile/offlineDeletePolicy.ts`
  (baseline-hash classification, batch brake 20 AND 25 %) wired into
  `ReconciliationController.runReconciliation` via `applyOfflineDeletes`.
  Closure evidence:
  - `tests/client/engine-offline-delete.ts` — controller-level wiring
    (real controller + real VaultSync, fake app, real
    `runReconciliation("authoritative")`): proven local delete → tombstone,
    no write-back, index entry dropped, second reconcile stays dead, delete
    visible in a second Y.Doc; the "write anyway" cases (remote edit, no
    baseline, excluded path, still-on-filesystem) and conservative mode
    unchanged; mass-delete brake.
  - Efficacy proof (this branch): with `applyOfflineDeletes` neutered the
    suite fails exactly 5 assertions (tombstone / no-write-back /
    re-reconcile / cross-device / block-trace); restored → green.
  - Real-device regression: QA scenario
    `issue-22-disable-reenable-local-delete-remote-unchanged`
    (qa/controllers/two-device.ts) flipped from soft "KNOWN ISSUE" log to
    hard fail on both legs — no resurrection on the deleting device, and
    delete propagation to the peer (the same live `DiskMirror`
    remote-delete path that s15 Phase 3 already hard-asserts). Baseline
    hash survives the disable/reenable round-trip via persisted plugin
    state (`_diskIndex`).
- **SYNC-02 (bound-file edit discard)** — fixed upstream, engine step 3
  (`a667248`): `preserveCrdtIfBothSidesChanged` keeps the overwritten side
  as a local-only conflict note when both sides changed from the baseline.
  Closure evidence:
  - `tests/client/engine-bound-both-changed.ts` — controller-level wiring
    (real controller + real VaultSync, fake editor): both-sides-changed →
    CRDT preserved, artifact minted, editor side wins, duplicate-call
    dedupe; controls (single-side change, typing lag, no baseline)
    unchanged.
  - Efficacy proof (this branch): with `preserveCrdtIfBothSidesChanged`
    neutered the three artifact assertions fail; restored → green.
  - Remaining leg: real-device reproduction of the original iPad trace
    (needs the user's devices) — see Phase 0 gate.
- **ISSUE-68** —
  - *68a false "local state not yet received" warning*: fixed upstream
    (`1ed53e6`). The status bar now distinguishes "latest edit awaiting
    server confirmation" (an earlier state is confirmed) from "never
    confirmed"; `tests/client/server-ack-tracker.ts` Test 13 replays the
    reported sequence. The confirmation rule itself was audited and left
    unchanged (the reported state vectors could not be reproduced as a
    tracker fault; maintainer ruled the label non-breaking).
  - *68b auth rejection after idle (reload was required)*: audited on this
    branch — the fork already carries the full ticket lifecycle: proactive
    refresh timer (fires at `expiresAt − 30 s`,
    `scheduleSocketTicketRefresh`), best-effort force-refresh on every
    `disconnected` status event (the sleep/wake case), retry on transient
    fetch failure, and URL patching that strips legacy `?token=`. The
    sleep/wake scenario is covered by the live smoke test
    `tests/live/ws-ticket-reconnect.ts` (8 s ticket TTL). Result: mechanism
    present and tested; no code change required.
- **Global criterion**: Drive/CF carriers byte-identical — all 124
  regression suites pass on this branch (2026-10-03); `typecheck:qa`
  green. `docs/BACKLOG.md` still lists SYNC-01/02 as open — stale, ignore.

### Phase 0 — Feasibility spike (1–2 wks) — **GATE**

Deliverable: `docs/p2p/feasibility.md` with go/no-go per platform.

- T0.1 Raw WebRTC data-channel PoC between two Obsidian instances
  (desktop×2, then desktop+iOS, then desktop+Android), signalling stubbed
  locally (the production mechanism — offer in pairing code — is validated
  separately in T0.2).
- T0.2 **Embedded-offer pairing proof**: device A generates a pre-gathered
  trimmed offer, puts it in a code, device B (different network, then same
  LAN) connects from the code alone. Measure code size and QR capacity
  (real `qrcode` render, real phone scans).
- T0.3 **Deep-link proof**: QR → phone camera → `obsidian://yaos/p2p-pair?
  code=…` → plugin handler fires on desktop, iOS, Android.
- T0.4 Real Yjs sync over the channel (edit/restart/offline-resume); verify
  convergence + timing.
- T0.5 NAT traversal matrix: STUN-only outcomes (laptop–laptop,
  laptop–phone-4G, phone–phone-4G, same-WiFi), BD networks if possible.
- **Exit**: desktop direct = go (assumed); each mobile platform =
  go / degraded / no-go. No-go ⇒ that platform gets backbone-assisted mode
  + diagnostic row; architecture unchanged.

### Phase 1 — `P2pCarrier` core (2–3 wks)

New `src/p2p/`: `p2pCarrier.ts`, `peerLink.ts`, `frame.ts` (§4.5), `ice.ts`,
`mergedAwareness.ts`, `routingPolicy.ts`, `docRegistry.ts` (§4.2.3:
`__yaos.peers`/`__yaos.meta` read/write, LWW, size bounds, vault secret).

- T1.1 Data-channel protocol (sync/awareness/control frames; blob/snapshot
  frames stubbed until Phase 3).
- T1.2 Composite carrier: optional backbone adapter (`null` | Drive | CF
  transport), `origin === carrier`, `status`/`synced` semantics, merged
  awareness.
- T1.3 Settings: carrier row + backbone selector + TURN fields (§8);
  wizard first screen; status-bar copy per §4.10.
- T1.4 Test infra: `FakePeerConnection` (in-memory loopback with injected
  loss/delay/drops) + existing `FakeDrive`; unit tests for frame codec,
  registry, routing policy.
- T1.5 Fuzz `p2p-fuzz` (fixed seeds, ~6 s CI budget, `drive-carrier-fuzz`
  pattern): link opens/closes, duplicate two-path delivery, mid-transfer
  restarts, secret-rotation mid-session; invariants = convergence, no lost
  local edit, receipt honesty.
- T1.6 STUN refresh policy (B4): re-gather on network change + ≤ 1×/24 h;
  write the registry offer only when the candidate changed.
- T1.7 Network-change triggers (A3): app-foreground / network-return /
  Wi-Fi ↔ cellular switch each trigger an immediate backbone poll (when a
  backbone is on) and a background direct attempt; plus the
  `docs/sync-contract.md` receipt subsection from §4.10.
- **Exit**: two desktop instances sync live over a direct link with backbone
  `None`; backbone on ⇒ same scenarios pass with backbone as fallback;
  toggle matrix green.

### Phase 2 — Pairing UX (2 wks)

- T2.1 Code generation: on-demand trimmed offer (STUN pre-gather, ≤ 2
  candidates), code format `YAOS-P2P1:…`, copy field.
- T2.2 QR: extend `PairDeviceModal` (P2P mode: deep link + raw code text);
  deep-link routing in the existing `yaos` handler (`p2p-pair` action).
- T2.3 Pairing wizard: "Join with pairing code" (paste), secret/schema
  errors with exact messages, unreachable-anchor diagnostics with the §4.6
  guidance ladder (CF-first copy per A1/C1), `P2P network check` entry
  point.
- T2.4 "This vault" panel: per-peer rows (+ anchor badge, B1), pair/rotate
  actions, **Test direct link** button (B3), rotation = re-issue codes flow
  with member warnings.
- T2.5 Reachability probe + anchor role (B1): probe frames, ≤ 1×/10 min per
  peer, registry `anchor` flag, anchor-QR preference in the pairing modal.
- T2.6 `YAOS: P2P network check` command (B2): report + debug-export
  integration.
- **Exit**: QR-scan and paste pairing both work desktop→phone (per Phase 0
  results); wrong/rotated secret is rejected cleanly; unreachable anchor
  shows the guidance ladder, never a fake success.

### Phase 3 — Pure-P2P attachments & snapshots (2–3 wks)

- T3.1 `P2pBlobStoreClient` (push fan-out, `have-query` pull, chunking,
  hash verification, LRU local caps) behind the existing `blobSync.ts` seam.
- T3.2 `P2pSnapshotBackend` (local + replicate, retention all-pinned +
  newest 7, union browse list) behind the `snapshotBackend.ts` seam.
- T3.3 `attachmentOrchestrator`/`SnapshotService` integration; settings
  (replication on/off — default on; caps).
- T3.4 Fuzz extension: attachment transfer with concurrent link drops;
  snapshot restore from a peer-only snapshot.
- **Exit**: image/PDF added on laptop appears on phone over a direct link
  (and vice versa); a snapshot taken on phone is restorable on laptop;
  backbone-on configurations keep today's blob/snapshot behaviour.

### Phase 4 — Backbone adapters in settings (2 wks)

- T4.1 `DriveBackbone`: wire existing `DriveTransport` (wizard reuse,
  passphrase at first attach, request-budget settings on the backbone path).
- T4.2 `CfBackbone`: wire existing Cloudflare transport (claim/setup-code
  reuse).
- T4.3 Backbone switch flows (on/off/switch) with state preservation;
  registry entries ride the backbone (no extra mechanism); auto-discovery
  (a new peer entry appearing via backbone triggers dial attempts).
- T4.4 Receipt/status per §4.10 for each backbone flavour.
- T4.5 **Event-driven polling on the Drive backbone (A2)**: follow-up poll
  on fresh peer activity, request-meter bounded.
- T4.6 **Cellular data saver (A4)**: slower idle poll on mobile data +
  **Sync now** header button.
- T4.7 **TURN auto-ICE (B3)**: both peers advertise ⇒ automatic TURN ICE
  config (the TURN config fields themselves land here too).
- **Exit**: P2P+Drive and P2P+CF pass the full two-device CDP matrix;
  backbone off ⇒ zero backbone requests (request-meter assertion);
  event-driven polling never exceeds the budget table.

### Phase 5 — Multi-user sharing (2–3 wks, optional)

- T5.1 "Share with a person" (pure mode): QR/code handoff UX + honest
  reachability copy + rotation UX polish + docs.
- T5.2 Drive-sharing research: `drive.file` cross-client visibility for
  account-shared folders; fix wizard hint to match reality (fallback: same
  sign-in method).
- T5.3 Re-key = new vault ID + import flow for Drive-shared vaults (decided
  fallback), including snapshot/attachment carry-over.
- **Exit**: two people, different Google accounts (backbone case) or one
  person's second device (pure case), share one vault end-to-end; rotation
  and re-key behave exactly as documented.

### Phase 6 — Hardening, QA, docs, release (2–3 wks)

- T6.1 Real-device checklist (desktop + iOS + Android; pure mode and each
  backbone; 4G/Wi-Fi matrix; app suspend/resume; airplane 30 min; cold-boot
  second device; QR from laptop screen; wrong-secret; rotation).
- T6.2 `docs/p2p-carrier.md` (setup, pairing, the honest CGNAT/reachability
  table, budgets, security, switching) + the 5-minute **"P2P anchor at
  home"** guide (C2) + README comparison row + `CHANGELOG`.
- T6.3 Soak: one week of the maintainer's vaults in pure mode pre-release;
  `p2p-fuzz` + `drive-carrier-fuzz` + full regression suites in CI.
- T6.4 Release as `2.2.0-p2p.x`.
- **Exit**: release candidate; existing carriers byte-identical in tests;
  checklist green.

**Total**: core (A + 0–4 + 6) ≈ **12–16 engineer-weeks**; full vision
(+5) ≈ **14–19 engineer-weeks**.

---

## 10. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Obsidian mobile WebView WebRTC missing/buggy | Medium | Direct mode dead on that device | Phase 0 gate; runtime feature-detect ⇒ backbone-assisted + diagnostic row |
| R2 | **Pure default meets CGNAT reality**: many phone pairs can't complete pairing without a reachable device/TURN | High | First-run friction; "P2P doesn't work" reports | The CGNAT toolkit (§4.11): CF-first backbone recommendation (A1), event-driven polling (A2), network-change triggers (A3), data saver (A4), anchor probing (B1), `P2P network check` diagnostics (B2), TURN auto-ICE (B3), STUN refresh (B4); honest docs (C1/C2) |
| R3 | Two-path window hides an engine ordering bug | Low | Data loss | Yjs idempotence; §4.8 fuzz rule; CDP link-kill scenarios |
| R4 | Doc-registry bloat (offers in the Y.Doc) | Low-Medium | Bigger doc, more backbone writes | Write-on-change only (no heartbeats), ~2 KB/entry cap, LWW, ~16-device bound, GC of evicted entries |
| R5 | Pairing code / QR too large for QR capacity or paste UX | Low-Medium | Pairing fails on big SDPs | Candidate trimming (≤ 2), real-render + real-scan validation in Phase 0, fallback message guiding to backbone-assisted join |
| R6 | Attachment replication bandwidth/storage on phones | Medium | 4G charges / storage pressure | Replication toggle (default on), existing size caps, bounded fan-out, LRU eviction, pull-on-miss avoids re-download storms |
| R7 | Deep link (`obsidian://`) doesn't fire on some mobile OS/WebView combos | Low-Medium | QR pairing broken on that combo | Phase 0 proof; fallback = paste code (same content); per-platform matrix in the checklist |
| R8 | Vault-secret rotation orphans a legitimate member (lost code) | Medium (user error) | Member can't reconnect | Rotation warns + lists affected peers; members can always re-pair via any current member; doc explains the code is the credential (like a Wi-Fi password) |
| R9 | Scope creep toward "full anytype" (DHT, accounts, hosted relays) | Medium | Timeline slips | Non-goals (§1) are contractual; registry-not-DHT, no-hosting, code-as-key are deliberate simplifications |
| R10 | P0 backlog bugs leak into the P2P surface | Medium | Carrier inherits known loss bugs | Phase A hard prerequisite; their regressions re-run on the P2P carrier in CI |

---

## 11. QA strategy (summary)

1. **Unit**: frame codec, registry, routing policy, code/QR sizing (all pure).
2. **Fake-transport fuzz** (`p2p-fuzz`): fixed seeds, loopback WebRTC fake +
   fake Drive/CF; invariants = convergence, no lost edit, receipt honesty,
   secret rejection.
3. **CDP two-device** (existing `qa/controllers/two-device.ts`): link-control
   hooks (kill direct / force backbone / suspend app) running the existing
   scenario matrix (task-storm, delete-then-revive, rename, nasty-paths) in
   pure mode and each backbone mode.
4. **Analyzers** (`qa/analyzers/rules/`): unchanged, carrier-agnostic; a
   failing analyzer on P2P is a P0 bug.
5. **Pairing matrix**: QR-scan and paste, wrong secret, rotated secret,
   unreachable anchor, schema mismatch — each with expected exact UI state.
6. **Backbone-off assertion**: request meters show zero Drive/CF requests in
   pure mode.
7. **Real-device checklist**: per T6.1.

---

## 12. Open questions (before Phase 2/3 start — none blocking Phase 0)

1. **Offerer/dialer tie-break** (proposed: lexicographically-smaller
   `deviceId` always dials) — sign-off only.
2. **Attachment push fan-out** (proposed: all syncing peers, best-effort,
   pull back-fills) — verify with request/bandwidth metering in Phase 3.
3. **Snapshot N** for pure mode (proposed: all pinned + newest 7 daily,
   mirroring the Drive rule) — sign-off only.
4. **Wizard ordering**: should the P2P carrier be presented *first* in the
   setup wizard for the fork (product choice; default carrier on new
   installs stays unchanged unless you say otherwise).
5. **Phase 0 device availability**: agent runs desktop×2 + all protocol work
   here; iOS/Android legs need your phones (run the PoC command, paste
   logs back).

## 13. Success criteria (whole plan)

- Two devices, **no servers anywhere**: notes sync in ≤ 200 ms over a direct
  link; a third device joins by scanning one QR; attachments and snapshots
  replicate; cursors are live.
- Pairing works by **QR and by pasted code**; wrong or rotated secret is
  rejected with a clear message; a leaked member is cut off by rotation.
- **CGNAT**: a phone + laptop on different carrier/home networks sync
  near-instantly via the one-click Cloudflare relay (backbone), or within
  seconds via the Drive backbone; `YAOS: P2P network check` explains the
  topology (likely CGNAT, anchor status, per-peer path) in < 10 s.
- Kill any device at any moment: zero data loss on reconnection (when a path
  exists), both sides converge, status never lies (contract §4.10).
- Backbone `None` ⇒ **zero** Drive/Cloudflare requests (meter-asserted).
- Backbones optional and honest: P2P+Drive and P2P+CF pass the full matrix;
  existing Drive/Cloudflare carriers remain byte-identical in tests.
- A stranger can create a vault and pair a phone in < 5 min without a
  terminal; (Phase 5) share it with a second person.
- `p2p-fuzz` + all regression suites green in CI; the author hosts nothing.

---

## Appendix A — Anytype's three-layer stack, and where this plan matches
(researched 2026-10-03)

### What Anytype runs today

The open-source **any-sync** protocol ([repo, MIT-licensed](https://github.com/anyproto/any-sync), Go):
encrypted CRDT-DAG objects (files as IPLD), over **libp2p** (TCP +
yamux/DRPC, QUIC/UDP). Three networking layers
([protocol overview](https://tech.anytype.io/any-sync/overview)):

1. **Local p2p** — **mDNS** discovery + direct device-to-device, same LAN
   only ("local-only mode").
2. **Global via infrastructure nodes** — **coordinator** (resolves which
   node serves a space), **sync nodes** (store the *encrypted* space;
   devices dial them **outbound** — this is what makes CGNAT work, and
   solves the "closed-laptop problem"), **file nodes** (IPLD storage),
   **consensus nodes** (ACL validation). Self-hostable as one
   `any-sync-bundle` binary (TCP :33010 / QUIC :33020).
3. **Relay protocol** — relays bytes between peers that can't connect
   directly (both behind NAT).

Support is productized via the
[any-sync-netcheck tool](https://doc.anytype.io/anytype/resources/troubleshooting/anysync-netcheck-tool);
see also their [2025 retrospective](https://blog.anytype.io/our-journey-and-plans-for-2025/)
and a [self-hosted deployment write-up](https://deepwiki.com/robouden/openclaw-workspace/3.1-anytype-p2p-network-and-infrastructure).

### Why we don't use it directly (despite MIT)

1. **Runtime**: the client is Go with raw TCP/QUIC sockets. An Obsidian
   plugin is sandboxed JavaScript (WebView on mobile): no raw sockets, no
   process spawning, no WASM-socket path on iOS. Only a native app with a
   bundled daemon (Anytype's own shape) can host it.
2. **Data model**: their CRDT-DAG/IPLD objects vs our Yjs engine + disk
   bridge + editor binding — adopting it is a rewrite, not a feature.
3. **Node stack**: the protocol expects always-on coordinator/sync/file/
   consensus Go services — against the no-server default.

### Layer mapping (this plan is the same architecture, Obsidian-native)

| Anytype layer / component | Their implementation | Ours |
|---|---|---|
| Local p2p discovery | mDNS | Pairing code/QR + peer registry inside the Yjs doc (mDNS unavailable in Obsidian WebViews) |
| Direct link | libp2p TCP/QUIC | WebRTC data channels (DTLS) |
| Coordinator ("where is my space") | Coordinator node | The pairing/setup code carries the answer (vault id + secret + address) |
| Sync node (encrypted store, dial-out) | Anytype's sync nodes / any-sync-bundle | User-owned **Cloudflare Worker** (real-time) or **Drive folder** (polling) — the backbone option |
| File node | IPLD file nodes | R2 (CF) / Drive blob folder / P2P blob frames (pure mode) |
| Consensus / ACL node | Consensus nodes | Not needed (single-owner vault + vault secret) |
| Relay for NAT'd pairs | any-sync Relay protocol | CF Worker relays bytes + optional user TURN |
| Connectivity diagnostics | any-sync-netcheck | `YAOS: P2P network check` (B2) |

### Concepts borrowed

- netcheck-style one-tap diagnostics (B2);
- the "closed-laptop problem" phrasing for user-facing docs;
- hybrid bridging (a backbone-connected device relaying for a LAN-only
  device) — documented as D2, not built;
- the core insight that shapes A1: **an encrypted relay that devices dial
  out is the product; direct links are the optimization.** Our backbone
  option embodies it — and on cross-network failure the wizard now
  recommends it, Cloudflare first.
