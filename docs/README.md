# YAOS documentation

These are the durable engineering documents. Git history and the separate engineering library preserve replaced RFCs, audits, incident reports, and implementation notes.

Core:

- [Architecture](architecture.md) — current structure plus rationale for runtime, storage, startup, and attachment choices.
- [Sync and conflict contract](sync-contract.md) — current behavior, preservation policy, and receipt semantics.
- [Operations](operations.md) — deployment, update, authentication, compatibility, and release decisions.
- [QA](qa.md) — supported gates, current evidence, and manual real-device procedures.
- [Backlog](BACKLOG.md) — the canonical list of pre-feature bugs, validation gaps, and cleanup debt, plus the section that records what has since been resolved.

Carriers:

- [Google Drive carrier](drive-carrier.md) — setup, limits, hardening and what is guarded. It is experimental and off by default.
- [Drive carrier: device checklist](drive-carrier-device-checklist.md) — what to check on real hardware with a real Google account.
- [Drive carrier: device results](drive-carrier-device-results.md) — the record of those runs, with an explicit "not run" entry for anything unproven (the 2.1.23 real-account run is accepted unrun).
- [Local network carrier](lan-carrier.md) — desktop-only pairing over the LAN.
- [Drive carrier: review and fix plan](drive-carrier-fix-plan.md) — the review that produced the 2.1.23 work, kept as the record of what was planned and what was actually done.
- [COD-8: carrier switch warnings](COD-8-carrier-switch-warnings.md) — what the user is (and is not) told when switching carriers, the root cause, and the recommended fix. Investigation only; no code changed.

Configuration-sync preview (staging, off by default): [preview](config-sync-preview.md), [plan](config-sync-plan.md), [coverage](config-sync-coverage.md) and the [scenario register](config-sync-scenario-register.md).

The repository-root [README](../README.md) is the public product guide. Generated evidence belongs under ignored `qa-runs/`; workstation notes belong under ignored `notes/`.
