# AI Usage Widget Product Requirements

## Status

- Product: AI Usage Widget
- Version: 2.0.0
- Release target: macOS on the owner's Apple Silicon MacBook Air
- Upstream baseline: Claude Usage Widget v1.7.6
- Updated: 2026-08-30

## Problem

Claude and Codex expose subscription quota information through different local or private interfaces. Checking them separately makes it easy to miss an approaching limit. AI Usage Widget provides one small, local-first view of both accounts without collecting API keys or reading either CLI's credential files.

## Goals

1. Display every Claude subscription quota returned by the existing Claude web integration.
2. Display every Codex quota group and window returned by the locally authenticated `codex app-server`.
3. Never assume that a primary window is five hours or that a secondary window is seven days.
4. Keep provider failures isolated and retain visibly stale last-known data.
5. Keep authentication material in the Electron main process and OS-backed encrypted storage.
6. Migrate useful settings, encrypted Claude authentication, and history from Claude Usage Widget without modifying the old data.
7. Install as a new application identity so the old application remains a rollback until acceptance testing succeeds.

## Non-goals for 2.0.0

- OpenAI API organization usage or billing.
- Anthropic API organization usage or billing.
- Reading `~/.codex/auth.json` or `~/.claude/.credentials.json`.
- Capturing ChatGPT browser cookies.
- A TypeScript rewrite.
- Claiming that undocumented provider interfaces are stable.
- Public multi-user telemetry, analytics, or a hosted service.

## Provider strategy

### Claude

The Claude provider preserves the upstream browser-session integration and its private `claude.ai/api/organizations/...` usage endpoints. A dedicated Electron session holds the HTTP-only cookie. The renderer receives only normalized usage data and status codes.

### Codex

The Codex provider discovers the local `codex` executable and performs a bounded JSON-RPC exchange with `codex app-server --stdio`. It prefers `rateLimitsByLimitId`, iterates every limit dynamically, and uses the legacy `rateLimits` field only as a fallback. It never reads or copies Codex tokens.

The OpenAI organization Usage API is deliberately not used because it reports API-platform consumption rather than ChatGPT/Codex subscription quota.

## Normalized snapshot

Each provider returns:

- Provider identity and display name.
- Status, fetch timestamp, and stale state.
- Zero or more dynamic quota buckets.
- Optional credit summaries.
- A sanitized, stable error code.

Each quota bucket contains a stable ID, label, utilization percentage, optional window duration, optional reset time, and category. Raw provider payloads are not persisted.

## User experience

- The main window displays one independently refreshable card for each enabled provider.
- Any number of quota rows can be rendered.
- The menu-bar summary uses the highest utilization among current non-stale buckets; unrelated percentages are never added or averaged.
- Missing CLIs, logged-out accounts, provider outages, and stale data have distinct states.
- Settings control provider enablement, refresh interval, alerts, appearance, launch behavior, and Codex executable selection.
- History is selectable by provider and quota bucket.

## Privacy and security requirements

- No telemetry.
- No API keys.
- No direct credential-file reads.
- No plaintext Claude session key on disk.
- No credentials in renderer IPC, logs, diagnostics, fixtures, or history.
- Renderer networking remains disabled by Content Security Policy.
- Child processes use argument arrays with `shell: false`, a hard timeout, bounded output, and guaranteed cleanup.
- Configuration file permissions are hardened to `0600` where supported.

## Migration and rollback

On first launch, the new application reads the old config as an immutable migration source. It imports supported settings and history, and copies the encrypted Claude credential only if OS-backed decryption succeeds. Failure requests a new Claude login without deleting old data. The old app is removed only after the packaged replacement passes live acceptance tests, and removal is recoverable through the macOS Trash.

## Acceptance criteria

- Claude and Codex are visible after one refresh on the target MBA.
- All current Codex limit groups and windows are represented accurately.
- Launching from Finder discovers Codex despite a restricted GUI `PATH`.
- Provider errors do not suppress the other provider.
- No Codex child remains after refresh.
- Renderer and diagnostic payloads contain no authentication material.
- Old configuration remains intact after migration.
- Unit, integration, syntax, security, and packaged smoke checks pass.
- The installed replacement launches under `com.jameshan.aiusagewidget`.
- The upstream app is moved to Trash only after the replacement passes.

## Known risks

Both subscription data sources are undocumented or experimental and can change without notice. Provider adapters, sanitized contract fixtures, version diagnostics, stale caching, and independent failure states reduce recovery time but cannot eliminate that risk.

## Change log

### 2026-08-30 — Foundation

- Established the 2.0.0 all-in-one product identity.
- Selected a dynamic provider-adapter architecture.
- Defined security, migration, acceptance, and rollback requirements.
- Pinned Electron to the patched 41.10.7 release line.
