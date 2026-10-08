# Notice: Local network carrier

The **Local network carrier** (`src/lan-carrier/`) follows the design of the
**Local Sync** plugin for Obsidian:

- Project: https://github.com/liuboacean/obsidian-local-sync-plugin
- Author: liuboacean
- Licence: MIT

What was taken from it is the *mechanism*, not code that was copied across:
every device is server and client at once; links are WebSocket over TLS with a
self-signed ECDSA P-256 certificate; the certificate fingerprint is pinned; a
shared key signs devices in with a challenge-response; devices on the network
find each other with a UDP announcement every 5 seconds; heartbeat, reconnect
back-off, device time-out and sign-in lock-out use the same timings. The files
were written again for this repository (own WebSocket codec, YAOS Yjs sync
frames, English messages, repository lint rules). The files that carry the
mechanism (`lanAuth`, `lanCert`, `lanConstants`, `lanDiscovery`, `lanHub`,
`lanSocket`) say so in their header comments.

Changes from the original, chosen deliberately:

1. A random pairing key is created at setup and the carrier refuses to start
   without a strong key (the original falls back to the literal key
   `default-key`).
2. A device whose certificate fingerprint is not pinned is not accepted
   silently. The fingerprint is covered by the key-signed proof, so a
   middleman cannot substitute it, and sign-in is mutual.
3. The plain (unencrypted) WebSocket fallback does not exist.
4. Different default ports (8872 TCP, 8873 UDP; configurable), so both plugins
   can run side by side.

## Licence text of the original

MIT License

Copyright (c) 2026 liuboacean

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
