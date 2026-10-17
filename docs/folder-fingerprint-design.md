# COD-10 — Stable Drive folder fingerprint design

**Status:** Design proposal only; no product changes. Based on `google-drive-carrier` at `02d0068` and user decisions: permanent fingerprint, all devices share one remote folder, pause on multiple distinct folders with the same Vault ID, automatically enroll one unambiguous legacy folder.

## Why this happened

Google Drive permits duplicate folder names. The transport's `resolveVaultFolder()` (`src/drive-carrier/driveFolders.ts`) chooses a usable saved `driveFolderId`, otherwise the oldest visible folder named `YAOS <vaultId>`. It reports duplicates but does not use `meta.json` identity to select. `DriveKeyring.readMeta()` (`src/drive-carrier/driveKeyring.ts`) then sees the chosen folder has another Vault ID and correctly refuses all sync writes. The setup wizard's `createVault()`/`checkVaultForJoin()` and `DriveKeyring.ready()` have their own oldest-folder paths; the fix must cover them too. Different OAuth clients using `drive.file` may each see only their own app-created files, so devices can create separate folders even when their folder names and Vault IDs agree.

## Identity model

Do not hash folder contents: they change on every sync. Create a cryptographically random **folder identity** once at folder creation; derive its public fingerprint as `SHA-256("YAOS-folder-v1:" || folderIdentity)` encoded in hex. The random identity must never be regenerated on rename, sync or restart. A hash alone does not supply access control or authenticity; Drive metadata is only as trustworthy as the account's file access. Vault ID identifies the logical vault, while folder identity distinguishes physical folder histories. Google's folder ID is an address for one physical object, and the fingerprint validates the target and supports candidate comparison.

Existing code already puts a random `installId` in modern `meta.json`. Prefer reusing it **only after an audit** establishes that it is unique per physical folder, written on all creation paths, and not meant to be shared across separate folders or devices. The current duplicate warning explicitly describes the same install ID on two folders as a copy, so copied folders must still be treated as an ambiguity, not silently equated with the original. If its semantics cannot guarantee this, add a separate `folderIdentity` field, and version its meaning without breaking existing layout readers. A fingerprint cannot establish which copy has newer data.

Persist locally `{ vaultId, driveFolderId, folderFingerprint }` as one coherent binding, rather than three independently editable claims. Older settings may contain only a folder ID. When changing vault ID or sign-in client, invalidate/revalidate the binding; never silently reuse a pin for another vault. A second device needs the folder ID/fingerprint via verified pairing, or must discover exactly one verifiable candidate; its own newly generated identity would fork the vault.

## Selection policy

1. **Pinned folder:** fetch saved ID; inspect `meta.json`. Require matching Vault ID, supported layout and matching fingerprint. If it differs, stop without writing and display expected/observed identifiers. If inaccessible, do not assume it was deleted: `drive.file` may hide it. Pause for recovery.
2. **No pin:** list all accessible candidate folders, with complete pagination. Read and classify their metadata: verified matching vault, verified different vault, legacy no identity, empty, unreadable, incompatible layout. Never select by name/age alone. Do not treat a failed read as an empty folder.
3. **Exactly one verified matching folder:** select and save binding only after `ensureMeta()` succeeds. If other distinct *matching* folders exist, pause and ask; do not automatically merge their histories. A folder with another Vault ID is never eligible.
4. **Exactly one unambiguous legacy folder:** after confirming vault ID and layout, assign a random identity once using a race-safe metadata update (re-read/conditional update or equivalent create-and-read-back with deterministic conflict handling), then bind it. A missing `vaultId` in legacy metadata is not a confirmed match: require stronger evidence or explicit confirmation; do not infer identity from folder name alone.
5. **No matching folder:** only create a new folder in an explicit new-vault flow. In a join/recovery flow, pause and explain that the prior folder may be invisible with this OAuth client. Never silently create a second remote history.
6. **Two distinct matching folders:** pause sync and show folder IDs, fingerprints, creation timestamps and available diagnostics; ask the user which history to retain. Selection must not combine contents. A guided merge, if wanted, is a separate backed-up operation.

The UI should say **candidate** until the metadata has been verified; do not show “folder in use” before that check. A duplicate with the same fingerprint (copied metadata) still requires an explicit choice based on Drive folder ID. A pinned folder should not be silently displaced simply because another candidate exists; warn and provide a compare/recovery action.

## Implementation seams

- Centralize candidate resolution and verification in `src/drive-carrier/driveFolders.ts` or a dedicated folder-binding service, with explicit result variants (`selected`, `needs-choice`, `inaccessible`, `mismatch`, `unsafe-legacy`). Avoid mutating remote state during discovery.
- Route `src/drive-carrier/driveTransport.ts:prepareFolder`, `src/drive-carrier/driveKeyring.ts:ready`, and `src/drive-carrier/wizard/driveSetup.ts:createVault/checkVaultForJoin` through that policy. Audit blob/snapshot paths for any independent folder resolution.
- Keep `DriveKeyring.ensureMeta()` as the last safety gate before writes. Persist the new binding only after successful verification; handle async settings persistence failures explicitly.
- `src/drive-carrier/googleDriveRest.ts:findFolders` currently requests `pageSize=100` without following `nextPageToken`. Add pagination before claiming to examine *all* candidates.
- Extend the setup/pairing flow with a verified folder binding so new devices join the same physical folder when accessible. Do not place authentication tokens or passphrases in diagnostics.

## Test matrix and rollout

Test pinned valid/mismatch/inaccessible IDs; oldest wrong-vault vs newer matching; two matching but different identities; copied metadata with identical fingerprint and distinct Drive IDs; missing/invalid metadata; two simultaneous first writers; encrypted legacy folders; same account with different OAuth clients; >100 same-name folders; wizard and background transport agreeing; no writes on stop paths; migration/restart persistence and backward compatibility. Simulate two devices joining the same folder and a device that cannot see it. Use real Drive/Obsidian smoke tests after mocks.

Roll out with a read-only detection phase first, then enrollment and explicit choice UI. Keep the existing vault-ID mismatch guard throughout. Back up affected folders before any human-led recovery; no automatic deletion, metadata rewrite of a different vault, or cross-folder merge.

## Integration probe and compatibility gates

A local, **uncommitted and reverted** wiring probe exposed compatibility cases that must be solved before enabling selection in production. It changed transport and keyring folder lookup experimentally; the targeted folder-identity suite reported 14 failures and the crypto suite stopped in its concurrent-create test. The probe was reverted, not shipped. Specifically:

- The existing contract allows a saved trashed folder to fall back to lookup and create a new folder. Our agreed new safety policy pauses instead. This is an intentional behavior change that requires updated tests and an actionable recovery UI, not a quiet assertion change.
- Existing folder-identity tests expect an unpinned device to choose the oldest of two matching folders. Our agreed policy pauses and asks. It must display both IDs and preserve the pinned-device behavior.
- Older `meta.json` files without `vaultId` remain readable by `DriveKeyring`. A read-only identity inspection cannot treat this as a verified match, but cannot simply disable legacy joins; safe one-folder migration needs its own explicit case and test.
- The keyring's concurrent folder-creation/encryption test depends on both devices converging on the same folder before creating metadata. A blanket halt on two newly created empty folders breaks that flow. Resolve concurrent empty-folder races deterministically **before any vault data is written**, then verify the chosen `meta.json` and fingerprint; two initialized histories remain an ambiguity requiring user choice.
- The keyring's unsupported-layout error must remain the authoritative fatal error. Candidate classification should not replace it with a generic folder-choice message when there is one clearly selected folder.

Do not push the runtime integration until these contracts, the setup wizard, and the shared keyring/transport path pass focused tests. This is why the first code checkpoints are read-only rather than a partial behavioral rollout.
