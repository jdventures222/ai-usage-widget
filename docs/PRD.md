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

1. Display only Claude's 5-hour, 7-day, and Fable limits.
2. Display only the canonical general Codex quota returned by the locally authenticated `codex app-server`.
3. Exclude Codex Spark, GPT Reserve, Claude model/scoped limits other than Fable, spend controls, and credits from the dashboard and history by design.
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

The Codex provider discovers the local `codex` executable and performs a bounded JSON-RPC exchange with `codex app-server --stdio`. It selects only the canonical `codex` entry from `rateLimitsByLimitId`, discards every other limit group, and uses the legacy `rateLimits` field only when the multi-limit view is absent. It never reads or copies Codex tokens.

The OpenAI organization Usage API is deliberately not used because it reports API-platform consumption rather than ChatGPT/Codex subscription quota.

## Normalized snapshot

Each provider returns:

- Provider identity and display name.
- Status, fetch timestamp, and stale state.
- Only the quota buckets allowed by the product display policy.
- A sanitized, stable error code.

Each quota bucket contains a stable ID, label, utilization percentage, optional window duration, optional reset time, and category. Raw provider payloads are not persisted.

## User experience

- The default surface is a compact, translucent corner HUD that remains visible without taking focus.
- The HUD contains exactly four concise rows: one Codex summary and Claude 5-hour, weekly, and Fable usage.
- Clicking Expand reveals independent provider cards, recovery actions, history, and settings.
- The HUD starts inside the selected display corner, then remains freely draggable and resizable with separate compact and expanded bounds persisted across launches.
- Refreshes and content updates never alter user-selected geometry. Display removal or resolution changes only constrain enough of the window to keep it recoverable.
- Always-on-top, all-Spaces visibility, opacity, corner, auto-start, and Dock visibility are user-controlled; defaults favor a persistent low-profile MBA setup.
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
- Codex displays only the canonical general quota; GPT Reserve and Codex Spark never appear or enter history.
- Claude displays only 5-hour, 7-day, and Fable limits; other scoped limits, credits, and spend never appear or enter history.
- The default window is a compact four-row HUD placed in the configured screen corner, visible on every Space without stealing launch focus.
- The header moves the window, native edges/corners resize it, and compact/expanded geometry survives relaunch independently.
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

### 2026-08-30 — Provider core

- Added the normalized provider contract and independent provider manager.
- Added dynamic Codex multi-limit parsing and a bounded one-shot app-server client.
- Extracted Claude normalization and main-process-only credential handling.
- Added immutable legacy migration and normalized history conversion.
- Hardened hidden Claude fetch windows and removed provider-body fragments from errors.

### 2026-08-30 — Secure application shell

- Replaced the Claude-specific main process with the v2 provider manager.
- Added a dedicated Claude browser partition and one-shot Codex execution.
- Replaced credential IPC with narrow dashboard, settings, connection, picker, and diagnostics channels.
- Added main-process refresh scheduling, sleep/wake refresh, threshold notifications, and a highest-utilization tray summary.
- Added side-by-side application data and bundle identities.

### 2026-08-30 — All-in-one dashboard

- Replaced fixed Claude session/weekly rows with dynamic provider cards and arbitrary quota buckets.
- Added independent Claude and Codex connection/recovery actions.
- Added provider-selectable local history, credits, reset timers, stale banners, and a combined highest-usage summary.
- Added provider enablement, native Codex selection, threshold, refresh, theme, launch, menu-bar, history, and diagnostics settings.
- Rebranded renderer assets without retaining Claude-only product identity.
- Added an in-memory, authenticated one-time helper that decrypts the legacy Claude credential under its old Keychain identity and immediately re-encrypts it under the new app identity without writing plaintext.

### 2026-08-30 — Focused persistent HUD

- Narrowed the product display policy to canonical Codex usage plus Claude 5-hour, weekly, and Fable limits.
- Explicitly excluded GPT Reserve, Codex Spark, other Claude scoped limits, spend, and credits from display and history.
- Made the default surface a four-row, translucent, always-on-top corner HUD with no focus theft.
- Added compact/expanded modes, safe-area corner anchoring, all-Spaces visibility, opacity control, and persistent launch behavior for the target MacBook Air.
- Added unrestricted manual movement and bounded native resizing, with independent compact/expanded geometry and no refresh-driven snapping.
