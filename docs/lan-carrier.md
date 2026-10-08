# Local network carrier

A third way to sync a vault, next to Cloudflare (default) and Google Drive: your
**desktop** devices talk to each other directly over your home or office
network. No server, no account, no cloud. Nothing changes unless you choose it.

Design source: [Local Sync](https://github.com/liuboacean/obsidian-local-sync-plugin)
by liuboacean (MIT), see `NOTICE-local-sync.md`.

## Using it

1. Settings → YAOS → **Sync carrier** → **Local network (desktop only)**. The
   plugin makes this device's pairing key and certificate and starts.
2. On the first device press **Copy setup code**.
3. On every other device choose the same carrier, paste the code under **Join
   with a setup code**. The vault id and the pairing key are taken over.
4. Keep Obsidian open on both. Devices on the same network find each other
   within a few seconds; the status line says who is linked.

If devices are on different subnets, or discovery is blocked, type the other
device's address (`192.168.1.20` or `192.168.1.20:8872`) under **Local network
(advanced) → Addresses of other devices**.

The first start may ask your operating system to allow the app to listen on the
network (Windows and macOS firewall). Allow it for private networks.

## How it works

| Piece | What it does |
| --- | --- |
| Link | WebSocket over TLS (self-signed ECDSA P-256). Every device is server and client at once. Own small WebSocket codec (`lanSocket.ts`, `lanFrames.ts`); interoperability with the `ws` library is tested. |
| Sign-in | Both sides prove they know the pairing key, bound to the certificate the other side sees (`lanAuth.ts`). A middleman with a different certificate fails. Five wrong tries lock the source for five minutes. |
| Pinning | The first time a device is reached, its certificate fingerprint is remembered (`lanPins` in the plugin settings). A different certificate later is refused until you press **Forget** for that device. |
| Discovery | A UDP announcement every 5 seconds on private address ranges only; devices time out after 30 seconds (`lanDiscovery.ts`). Can be switched off. |
| Reliability | Ping every 120 s, drop after 240 s; reconnect back-off 1 s → 60 s. |
| Sync | The `SyncTransport` seam (`lanTransport.ts`): Yjs sync step 1/2 and updates, relayed through a middle device (A–B–C), receipts so the status shows "saved on another device". Remote updates apply with the transport as origin, as the seam contract requires. |
| Attachments | Requested from linked devices by hash and checked against the hash before use (`lanBlobStore.ts`). |
| Restore points | Local to the device (`lanSnapshotBackend.ts`). |

Files the carrier keeps live in `<vault>/.obsidian/plugins/yaos/lan/`, which
sync never touches.

## Safety choices

- A random 64-hex-digit pairing key is made at setup. The carrier refuses to
  start without a strong key.
- There is no plain (unencrypted) fallback.
- Announcements are only accepted from private address ranges (10.x, 172.16-31.x, 192.168.x). Links themselves are protected by the key and the pinned certificate, not by the address.
- The pairing key is part of the setup code. Treat the code like a password.
  **Create a new pairing key** replaces it; every device must then join again.

## Limits (stated in the settings screen too)

- **Desktop only.** Obsidian on Android and iOS cannot run a server socket, send
  UDP, or reach a self-signed secure link. With this carrier chosen on a phone,
  sync stays off and a notice says why. Use Google Drive or Cloudflare there.
- **Same network.** UDP discovery does not cross routers or VLANs; guest Wi-Fi
  with client isolation blocks it. Use typed-in addresses where you can.
- **Both devices must be on at once** to exchange changes. Edits made while the
  other device is off wait in local storage and merge when it returns.
- **One carrier at a time.** Choosing Local network switches the others off.
- Each device keeps its own copy of every attachment (two copies on disk: the
  vault file and the carrier's verified copy).
- Restore points are not shared between devices.
- Proven on loopback with real sockets, certificates and UDP; behaviour on your
  router, firewall and Wi-Fi is not covered by the automated tests. See section
  18 of `docs/drive-carrier-device-checklist.md` (to be done on two real PCs).

## Code map

`src/lan-carrier/`: `lanTransport`, `lanHub`, `lanSocket`, `lanFrames`,
`lanAuth`, `lanCert`, `lanDiscovery`, `lanProtocol`, `lanConstants`,
`lanNode` (lazy Node loaders), `lanBlobStore`, `lanSnapshotBackend`,
`lanFileStore`, `lanSettings`, `lanSettingsRows`, `lanCarrierRuntime`.

Tests: `tests/client/lan-*.ts` and `tests/mocks/lanRig.ts`.

## 2.1.21 restore and authentication safety

- Authentication proofs must be exactly 64 lowercase hexadecimal characters.
  Malformed Unicode or non-hex proofs are refused without throwing out of the
  socket callback. Handler exceptions close that link, not the listening hub.
- Restore-point list, daily scheduling, downloads and pruning consider only the
  active vault ID. New IDs include a SHA-256 vault namespace, preventing two
  vaults sharing the local directory from overwriting the same snapshot name.
  Runtime backend caches are per vault. Old timestamp-only snapshots remain
  available when their index matches that vault; nothing is automatically moved
  or deleted to migrate storage. Foreign/missing-vault entries are not restored.
- Before applying a restore point, its compressed/raw sizes and raw SHA-256 must
  match the selected index. Missing hashes are refused. Decompression is bounded
  by the validated 32-bit gzip length declaration, without a smaller arbitrary
  vault-size cap.
  Restoring a renamed historical note makes a separate identity rather than
  modifying the current note at its new path.

## Configuration staging preview (2.1.22)

The default-off [configuration safety preview](config-sync-preview.md) uses the
shared coordinator across all three carriers. It exchanges only reviewed JSON
projections and does **not** apply them to live configuration, including after
restart. The ordinary configuration-directory exclusion remains unchanged.
