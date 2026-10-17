/**
 * Fixed numbers of the Local network carrier.
 *
 * The timings are the ones the Local Sync plugin (MIT, liuboacean) uses; the
 * port numbers are our own so both plugins can run side by side.
 */

/** Default TCP port of the secure WebSocket server (Local Sync: 8888). */
export const LAN_DEFAULT_PORT = 8872;
/** Default UDP port used for discovery (Local Sync: 8889). */
export const LAN_DEFAULT_DISCOVERY_PORT = 8873;

/** Protocol version sent in the first message of every link. */
export const LAN_PROTOCOL_VERSION = 1;

/** A ping is sent this often, and a link that has been silent for twice as long is closed. */
export const LAN_HEARTBEAT_INTERVAL_MS = 120_000;
export const LAN_HEARTBEAT_TIMEOUT_MS = 240_000;
/** After a failed connection attempt the wait grows from 1 s to 60 s. */
export const LAN_RECONNECT_BASE_MS = 1000;
export const LAN_RECONNECT_MAX_MS = 60_000;
/** Failed sign-ins from one address before it is locked out, and for how long. */
export const LAN_AUTH_MAX_FAILURES = 5;
export const LAN_AUTH_LOCKOUT_MS = 300_000;
/** How often this device announces itself, and how long a silent device stays listed. */
export const LAN_DISCOVERY_INTERVAL_MS = 5000;
export const LAN_DEVICE_TIMEOUT_MS = 30_000;

/** A link that has not finished signing in after this long is dropped. */
export const LAN_HANDSHAKE_TIMEOUT_MS = 15_000;
/** Largest single message accepted from a peer (an attachment travels as one message). */
export const LAN_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
/** The receipt (state-vector echo) sent after applying remote data is delayed this long and merged. */
export const LAN_ACK_DELAY_MS = 50;

/** Certificate validity, as in Local Sync (10 years). */
export const LAN_CERT_DAYS_VALID = 3650;
