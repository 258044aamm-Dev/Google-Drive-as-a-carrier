# Google Drive carrier (experimental)

YAOS normally syncs through a Cloudflare Worker. The Drive carrier is an
alternative that needs **no server**: devices exchange the same Yjs updates by
writing small immutable files into a folder in the user's own Google Drive.

It is **off by default**. Nothing changes for existing setups; the carrier is
only used when you pick it in *Settings > YAOS > Advanced > Sync carrier*.

## How it behaves

- Changes travel as files in a Drive folder named `YAOS <vault id>`.
- Other devices notice new files by polling (about every 3 seconds), so edits
  arrive after a few seconds, not instantly.
- Cursors and presence of other devices are not shared (local only).
- Attachments and server snapshots are not available with this carrier yet.
- The status bar's "saved" state means "stored on Drive".
- Only the `drive.file` scope is requested, so YAOS can only see files it
  created itself, never the rest of the Drive.

## Setup (once per Google account)

Google's device sign-in needs an OAuth client of type **TVs and limited-input
devices**. YAOS cannot ship one for you, so you create your own (free):

1. In the Google Cloud console, create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (user type *External*). Add the scope
   `.../auth/drive.file`.
3. Create credentials > OAuth client ID > application type **TVs and limited-input devices**.
4. Keep the client **published** ("In production"). In "Testing" mode Google
   expires refresh tokens after 7 days. (`drive.file` is not a sensitive scope;
   confirm in the console what your project requires.)

Then, on each device:

1. Settings > YAOS > Advanced > **Sync carrier** > *Google Drive (experimental)*, then reload the plugin.
2. Paste the **client ID** and **client secret**.
3. Press **Sign in with Google**, open the shown address on any device and enter the code.
4. Reload the plugin. Syncing starts.
5. On the second and later devices, set the **same Vault ID** (Advanced > Vault ID).

The refresh token is stored in the plugin's `data.json` next to the other
settings, exactly like the Cloudflare sync token. It never leaves the device
except to talk to Google.

## Switching back

Choosing *Cloudflare Worker* again restores the previous behaviour; the
Cloudflare settings are never removed. Only one carrier is active at a time.
