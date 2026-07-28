# AutoDOM 4.3.0 local release readiness

Prepared: 2026-07-28

Status: **code-complete for review; remote release not authorized**.

## Completed gates

- Manifest, server package, lockfile root, and lockfile package entry all report
  `4.3.0`.
- FastMCP upgraded to `4.12.1`; stdio, logger path, WebSocket auth, reconnect,
  proxy reconnect, concurrent multi-IDE traffic, and end-to-end tool routing
  passed.
- Removed the pre-4.9 capability-warning suppression. Result metadata,
  progress, JSON Schema adapter, custom transport, and elicitation APIs remain
  intentionally unadopted: existing result content, Zod contracts, manual SSE,
  and REST compatibility have no measured reliability gain from changing.
- `npm ci` passed. `npm audit --audit-level=high` reports zero
  vulnerabilities.
- JavaScript, manifest JSON, shell syntax, and the full 50-test Node suite
  passed.
- Public MCP inventory test covers 106 unique registrations and requires each
  direct registration to retain description, parameters/schema, and execute
  handler.
- Update lifecycle tests cover manifest-only discovery, pending update,
  unpacked bridge update, ineffective reload → bounded blocked state, active
  agent deferral, stale state, and periodic scheduler behavior.
- Policy fixture tests cover Chrome, Edge, Chromium, and best-effort Brave
  plist/JSON/registry targets plus installer verification and removal paths.
- Legacy unpacked updater now uses checksummed metadata, bounded streaming,
  staged validation, Git-worktree refusal, atomic replacement, and rollback.
- GitHub Actions and CRX packer references are pinned by regression tests.
- `runUpdateCheck` measured cyclomatic complexity fell from 79 to 31.

## Local artifacts

| Artifact | Size | SHA-256 |
|---|---:|---|
| `dist/autodom-chrome-4.3.0.zip` | 306.4 KiB | `30304162ab75bc3f6e468612db1a9f435952b7017fa2d33124462fe5d7ae5962` |
| `dist/autodom-4.3.0-share.tar.gz` | 745.5 KiB | `8e259829c7b5a43d2b857aa763a09a70fd91597f8b82b91c51c9d85c648d1062` |
| `dist/autodom-4.3.0-share.zip` | 759.6 KiB | `b514e87e725497ed25c18510c57b31f8b55c3088c86b21af965c6289e2aeb7e2` |

Chrome ZIP manifest and both share bundles were inspected for version and
required updater/server files. Temporary `updates.xml` and `updates.json` were
generated for 4.3.0 with canonical URLs, extension ID, schema, and the local ZIP
digest. No live update channel was changed.

## Manual release gates still required

- Confirm Chrome and Edge managed policy activation on real managed devices.
- Confirm Brave policy behavior as best-effort only.
- Exercise unpacked share-bundle update against a disposable 4.2.x bundle.
- Confirm Git-worktree refusal on macOS, Linux, and Windows filesystems.
- Sign the CRX with the existing private key, verify the derived extension ID,
  and replace placeholder CRX metadata with its real SHA-256.
- Review diff, commit intentionally, then request separate approval before any
  push, tag, GitHub release, or live `gh-pages` update.
