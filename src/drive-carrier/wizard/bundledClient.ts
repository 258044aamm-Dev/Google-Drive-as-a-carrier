import type { GoogleClient } from "../googleAuth";

/**
 * The Google OAuth client built into the plugin, so a beginner only has to
 * press "Sign in with Google". Google treats the secret of an installed app as
 * public, so it may live in the source.
 *
 * It is `null` until the fork owner creates one (see docs/drive-carrier-wizard.md);
 * the wizard then offers only "use my own Google client". Fill both values in
 * to switch the built-in path on; nothing else needs to change.
 *
 * Keep in mind: Drive's `drive.file` access belongs to one client. Files a
 * vault created through this client cannot be seen through another one.
 */
export const BUNDLED_GOOGLE_CLIENT: GoogleClient | null = null;
