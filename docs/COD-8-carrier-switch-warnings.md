# COD-8 — Carrier switching: what the user is warned about, and what is missing

Investigation record for Linear issue **COD-8** ("no warning when switching from one
carrier to another"). Written against `google-drive-carrier` @ `18b714b`
(release 2.1.23).

**Status: the recommended fix is implemented and shipped on this branch** (see
[§9](#9-what-was-implemented)). Sections 1–8 are the investigation record, kept
as written when the fix was still only a proposal, so the evidence and the
reasoning behind each decision stay readable.

The investigation itself changed no product code; the fix that followed it is
described in §9 and is confined to the carrier branch of the settings tab.

---

## 1. Summary

| Question | Answer |
| --- | --- |
| Is any warning shown today? | Yes — exactly one, and only **after** the switch is already saved: `Reload the plugin (or restart Obsidian) to switch the sync carrier.` (8 s toast). |
| Is the user warned **before** the switch? | **No.** No confirmation dialog, and no statement of what switching does. |
| Is anything said about data not carrying over? | **No.** |
| Is anything said about other devices? | **No.** The switch is per-device; the other devices keep the old carrier until they are switched too. |
| Is anything said about unsynced / in-flight work? | **No**, and there is currently no plumbing that could say it. |
| Are there paths with **no message at all**? | **Yes, two.** When `host.lan.prepare()` rejects, and when `host.updateSettings()` rejects, the switch handler throws before reaching the notice (evidence in §4). |

So the report is: the warning exists but is (a) in the wrong place — after the
commit rather than before it, (b) about the wrong thing — a reload hint rather
than the consequences of the switch, and (c) unreachable on two failure paths.

## 2. How carrier switching works today

Files and lines, all on `google-drive-carrier` @ `18b714b`:

| Concern | Location |
| --- | --- |
| Carrier kind and defaults (`carrier` absent = Cloudflare) | `src/drive-carrier/carrierSettings.ts:8`, `:66-83` |
| The row itself | `src/settings/settingsTab.ts:518-531` (`carrierRow()`, `carrierOptions()`) |
| Option labels | `src/settings/settingsTab.ts:127-131` (`CARRIER_OPTIONS`) |
| Where the row is placed (Cloudflare / Drive) | `src/settings/settingsTab.ts:505-515`, `:556-610`, `:634-660` |
| Where the row is placed (Local network) | `src/lan-carrier/lanSettingsRows.ts:171` (`lanLayout`) |
| **The write path — the whole warning surface** | `src/settings/settingsTab.ts:1026-1035` (`setControlValue`, `case "carrier"`) |
| Read path | `src/settings/settingsTab.ts:878` → `currentCarrier()` |
| Runtime effect (chosen at plugin load) | `src/main.ts:664-687` (Drive), `:688-700` (Local network), Cloudflare otherwise |
| Static "Reload required" note | `src/settings/settingsTab.ts:473`, rewritten for Drive at `:590-591` and for LAN at `src/lan-carrier/lanSettingsRows.ts:191-192` |

The plugin uses Obsidian 1.13's declarative settings API: the tab overrides
`getSettingDefinitions()` / `getControlValue()` / `setControlValue()`, and
Obsidian renders the rows and awaits `setControlValue` (the API docs state the
promise is awaited "before re-rendering"). `setControlValue` therefore *is* the
carrier-switch event; there is no other hook.

The current handler, verbatim (`src/settings/settingsTab.ts:1026-1035`):

```ts
case "carrier": {
    const nextValue = expectStringValue(key, value);
    if (!isCarrierKind(nextValue)) throw new RangeError(`Unsupported sync carrier: ${nextValue}`);
    await this.host.updateSettings((settings) => { settings.carrier = nextValue; }, "settings:carrier");
    // Choosing Local network: make this device's key and certificate now, so the setup code can be copied before the reload.
    if (nextValue === "lan") await this.host.lan?.prepare();
    new Notice("Reload the plugin (or restart Obsidian) to switch the sync carrier.", 8000);
    this.update();
    // Choosing Drive for the first time: walk the user through the rest.
    if (nextValue === "drive" && !isDriveSignedIn(this.host.settings)) this.host.openDriveWizard?.();
    return;
}
```

Note the ordering: **save → optional await → notice**. Both awaits are before
the only message.

## 3. Method

The switch path was executed headlessly, outside Obsidian, by calling the real
`VaultSyncSettingTab.setControlValue("carrier", …)` — the same call Obsidian's
renderer makes — with a fake `VaultSyncSettingsHost` in the shape already used
by `tests/client/declarative-settings.ts`, and with a recording `Notice` /
`Modal` substituted for the `obsidian` package (the real package ships no
runtime JS).

The probe lives **outside** the repository (`cod8-harness/probe.ts`); it is run
with the repo's own jiti alias set. See §9.

## 4. Evidence — every transition, and what the user sees

`lan.prepare` = the Local-network key/certificate step. "Notices" is what the
product code raised.

| # | Switch | Saved? | Threw? | Notices shown | Modals opened | Wizard opened |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Cloudflare → Drive (not signed in) | drive | no | reload notice | none | 1 |
| 2 | Cloudflare → Drive (signed in) | drive | no | reload notice | none | 0 |
| 3 | Cloudflare → Local network (desktop) | lan | no | reload notice | none | 0 |
| 4 | **Cloudflare → Local network, `prepare()` rejects** | **lan** | **yes** | **none** | none | 0 |
| 5 | Cloudflare → Local network, no LAN host (phone) | lan | no | reload notice | none | 0 |
| 6 | Drive → Cloudflare | cloudflare | no | reload notice | none | 0 |
| 7 | Drive → Local network | lan | no | reload notice | none | 0 |
| 8 | Local network → Cloudflare | cloudflare | no | reload notice | none | 0 |
| 9 | Local network → Drive (signed in) | drive | no | reload notice | none | 0 |
| 10 | **Cloudflare → Cloudflare (same value re-picked)** | cloudflare | no | **reload notice** | none | 0 |
| 11 | **Drive → Cloudflare, `updateSettings()` rejects** | drive (unchanged) | **yes** | **none** | none | 0 |

Dropdown options, by platform:

- desktop (`lan.available === true`): `Cloudflare Worker (default)`, `Google Drive (experimental)`, `Local network (experimental, desktop only)`
- phone (`lan.available === false`): `Cloudflare Worker (default)`, `Google Drive (experimental)` — the Local network option is filtered out at `src/settings/settingsTab.ts:529-530`

Three things fall out of this table:

1. **No path asks for confirmation.** `ConfirmModal` is never opened (`src/settings/settingsTab.ts` does not import it at all), although the codebase already uses it for the two destructive actions in `src/main.ts:1694` ("Reset local cache") and `src/main.ts:1738` ("Nuclear reset").
2. **Rows 4 and 11 are silent.** The promise rejects, so `new Notice(...)` at `:1032` is never reached. In row 4 the carrier is *already saved* as `lan` while the device has no key or certificate — the user is told nothing and the settings screen re-renders as if nothing happened.
3. **Row 10 is noise.** Re-picking the carrier that is already selected fires the reload notice anyway.

## 5. Root cause

**Primary (why there is no *warning*): the carrier switch has no pre-commit step at all.**
`case "carrier"` in `setControlValue` is the entire feature, and its only user
message is a post-commit reload hint. The declarative API gives the plugin a
single synchronous-ish write hook and the plugin chose to persist first and
inform second. Nothing in the row's description, the notice, or the surrounding
page tells the user what switching means.

**Secondary (why there is sometimes *nothing*): the only message sits behind two awaits that can reject.**
`await this.host.updateSettings(...)` (`:1029`) and `await this.host.lan?.prepare()`
(`:1030`) both run before `new Notice(...)` (`:1032`). Any failure there escapes
`setControlValue` as a rejected promise and the user sees no message — while, in
the LAN case, the setting has already been written.

**Contributing gaps:**

- **No unsynced-work awareness.** `VaultSyncSettingsHost` (`src/settings/settingsTab.ts:97-127`) exposes no pending-write state; the engine's `hasPendingUploads()` / `hasPendingDownloads()` are private (`src/sync/blobSync.ts:1041`, `:1560`). The settings layer cannot know whether work is outstanding. `docs/config-sync-scenario-register.md:97` already lists **E12 — Carrier switch with outstanding writes** as only partially implemented.
- **Per-device semantics are never stated.** Nothing says the choice applies to this device only, and that other devices keep syncing through the old carrier.
- **"Nothing is migrated" is never stated.** The three carriers hold separate copies of the vault; the row's description only says *"Where your notes are exchanged between devices"*.
- **Inconsistent static note.** On the plain Cloudflare/Advanced page, the "Reload required" row reads *"Changing the server URL, sync token, or vault ID requires reloading the plugin."* (`src/settings/settingsTab.ts:473`) — it does not mention the carrier, although the carrier row is on that same page once a server is configured. The Drive (`:590-591`) and LAN (`src/lan-carrier/lanSettingsRows.ts:191-192`) variants do mention it.

## 6. Expected behavior

Agreed with the maintainer on COD-8:

- **Before** the switch: a blocking confirmation that states, for the specific transition, what the user is accepting.
- **After** the switch is committed: a notice that it takes effect on reload (keep the existing wording, extend it).
- **On failure**: always say something — a failed switch must never be silent.

Warning content should cover (per the maintainer's scope choice):

1. that the change takes effect only after a reload;
2. that nothing is copied between carriers — each carrier holds its own copy of the vault;
3. the destination's prerequisites (Drive: sign-in, and the same vault ID and encryption passphrase as your other devices; Local network: desktop only, same network, both devices on at once);
4. that the choice is **per device** — other devices keep the old carrier until they are switched too;
5. that unsynced / in-flight work should be allowed to finish first.

## 7. Recommended fix (implemented — see §9)

Constraints taken from the issue: follow the existing architecture, touch
nothing unrelated, and keep the current switching behavior otherwise.

1. **Ask first, through a host hook, not a modal imported into the settings tab.**
   Add an optional member to `VaultSyncSettingsHost` (`src/settings/settingsTab.ts:97-127`):
   ```ts
   /** Asks the user to confirm a risky change. Absent = allow (tests, hosts that do not implement it). */
   confirmSwitch?(request: { title: string; message: string; confirmLabel: string }): Promise<boolean>;
   ```
   `src/main.ts` implements it with the existing `ConfirmModal`
   (`src/ui/ConfirmModal.ts`), exactly as `resetLocalCache()` (`:1694`) and
   `nuclearReset()` (`:1738`) already do. In `case "carrier"`, call it **before**
   `updateSettings` and return unchanged when it resolves `false`.
   *Why a hook:* `ConfirmModal` extends `Modal`, and the test mock's `open()` is a
   no-op (`tests/mocks/obsidian.ts:51-55`), so a modal created directly inside the
   settings tab could not be asserted headlessly. A hook is testable, and because
   it is optional, any host that does not provide it keeps today's behavior — no
   regression for other settings or other consumers.

2. **Make the message a pure function.** e.g.
   `carrierSwitchMessage(from: CarrierKind, to: CarrierKind, state: { signedIn: boolean; lanAvailable: boolean; hasUnsyncedWork: boolean }): string`,
   so the text is unit-testable without a DOM and the six transitions are pinned
   by assertions instead of by eye.

3. **Make the notice unconditional and honest.** Wrap `lan.prepare()` in
   `try`/`catch` so a key-generation failure still produces a message that says
   what failed, and keep the reload notice for the successful path. Suppress the
   whole flow when `to === from` (row 10 above).

4. **Optional, and only if wanted in the same change:** surface unsynced work
   through the host as a read-only, optional accessor on the sync engine (a
   boolean is enough). This is the one item that touches `src/sync/`; it can be
   deferred to a follow-up and the warning shipped without sentence 5 above.

5. **Tests.** Extend `tests/client/declarative-settings.ts` (it already builds a
   fake host and calls `setControlValue`) with: declined confirmation → nothing
   saved; accepted confirmation → saved and notice raised; LAN `prepare()`
   rejection → still raises a message; same-value → no-op; and one assertion per
   transition for the message text. Keep the repo's gates green: `build`,
   `typecheck:tests`, `typecheck:qa`, the six `guard:*` scripts, `lint`
   (must stay 0 errors / 24 warnings) and `test:regressions` (must stay 141/141).

6. **Manual verification** belongs in
   `docs/drive-carrier-device-checklist.md`, next to the existing "Switching to
   Drive and back to Cloudflare restores the old behaviour" item (line 75).

**Compatibility:** no CRDT schema change, no encryption-format change, no
settings migration and no new required setting. `carrier` remains the same
optional field; only the `case "carrier"` branch of `setControlValue` changes.
Every other settings key, every other page and every carrier's sync behavior are
untouched.

## 8. Not verified

Stated plainly, following this repo's convention of recording what was *not*
proven:

- **How Obsidian 1.13 presents a rejected `setControlValue`.** The API docs say
  Obsidian awaits the returned promise; they do not document rejection
  behaviour. Rows 4 and 11 prove the plugin raises no message of its own, but
  whether Obsidian adds one of its own needs a check inside real Obsidian.
- **Toast placement and visibility.** The probe runs the product code under the
  repo's jiti alias with a recording `Notice`; it is not the real renderer, so
  where the toast appears and whether the user notices it was not tested.
- **Real Google Drive and real LAN behaviour** were not exercised. Unchanged from
  the status quo: the automated suites use fakes
  (`tests/mocks/fakeDrive.ts`, `tests/mocks/lanRig.ts`).
- **The unsynced-work sentence** depends on item 4 in §7, which does not exist
  yet; until it does, that part of the warning cannot be truthful and should be
  omitted rather than guessed.

## 9. What was implemented

Carried out as recommended in §7, in three commits on `google-drive-carrier`:
`af9a946` (investigation record), `fa9777a` (the fix) and `17a5d4f` (tests).

| Change | Where |
| --- | --- |
| Optional `confirmSwitch?(request)` hook added to the settings host | `src/settings/settingsTab.ts` |
| `carrierSwitchMessage(from, to, state)` — the plain-language description, a pure function | `src/settings/settingsTab.ts` |
| The confirmation itself, using the existing `ConfirmModal` | `src/main.ts` (`confirmSwitch`) |
| Type re-export for the plugin | `src/settings.ts` |
| New suite `carrier-switch-warning` (52 checks) | `tests/client/carrier-switch-warning.ts` |

Behaviour now, per transition:

1. **Ask first.** The host is handed the switch and what it does. Declining saves nothing, says nothing and is not an error. The carrier is the only setting that asks; every other setting still saves immediately.
2. **Say what it does.** The message covers all five points from §6: nothing is copied between carriers, the choice is per device, syncing should be allowed to finish, what the destination needs, and that a reload makes it take effect.
3. **Never fail in silence.** A failed save says the carrier was *not* switched; a failed local network key/certificate says the carrier *was* switched but preparation failed. Both still reject, exactly as before, so nothing downstream sees a different contract.
4. **No-op on re-selection.** Re-picking the carrier already selected no longer fires the reload toast.

What was deliberately **not** changed:

- **`src/sync/` is untouched.** There is still no public pending-write API, so the unsynced-work point is an unconditional sentence rather than a live count. Making it live remains a separate, larger change.
- **No new dependency of the settings tab on a modal.** The tab still never imports `ConfirmModal`; the host owns the dialog. `ConfirmModal` already accepted a cancel callback, so the shared component needed no change either.
- **No schema, encryption or settings-format change.** `carrier` remains the same optional field; no migration is required and no new setting is introduced.

Verification: `build`, `typecheck:tests`, `typecheck:qa`, the six `guard:*`
scripts and `lint` (0 errors / 24 warnings, identical to before) all pass, and
`test:regressions` reports **142 passed / 0 failed** — the 141 suites that
existed before plus the new one.

Still to do by hand: the real-device check belongs next to
*“Switching to Drive and back to Cloudflare restores the old behaviour”* in
`docs/drive-carrier-device-checklist.md` (line 75), and the entry belongs in
`CHANGELOG.md` when this is released (the file has no "Unreleased" section, so
it was not edited speculatively).

## 10. Reproducing this investigation

From the repository root, with dependencies installed
(`npm ci` and `npm ci --prefix server`):

```
JITI_ALIAS='{"yjs":"<repo>/node_modules/yjs/dist/yjs.mjs",
             "obsidian":"<probe-dir>/obsidian-mock.ts",
             "partyserver":"<repo>/tests/mocks/partyserver.ts",
             "@shared":"<repo>/server/src/shared"}' \
  node --import jiti/register <probe-dir>/probe.ts
```

The probe builds the same fixture shape as
`tests/client/declarative-settings.ts` and prints, per scenario, the saved
carrier, whether the call threw, the number of `lan.prepare()` calls, the wizard
opens, and every notice raised.
