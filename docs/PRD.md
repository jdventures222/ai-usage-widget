# AI Usage Widget Product Requirements

## Status

- Product: AI Usage Widget
- Version: 2.1.0
- Release target: macOS on the owner's Apple Silicon MacBook Air
- Acceptance: installed and live-verified on the target MacBook Air
- Distribution: locally ad-hoc signed; not Developer ID signed or notarized
- Upstream baseline: Claude Usage Widget v1.7.6
- Updated: 2026-09-30

## Problem

Claude subscription quota is exposed only through a private web interface. Checking it by hand makes it easy to miss an approaching limit. AI Usage Widget provides one small, local-first view of the account without collecting API keys or reading Claude Code's credentials.

## Goals

1. Track one Claude subscription account.
2. Display only its all-models 5-hour, all-models 7-day, and Fable 7-day limits.
3. Exclude other Claude model/scoped limits, spend controls, and credits from the dashboard and history by design.
4. Keep failure states distinct and retain visibly stale last-known data.
5. Keep authentication material in the Electron main process and OS-backed encrypted storage.
6. Migrate useful settings, encrypted Claude authentication, and history from Claude Usage Widget without modifying the old data.
7. Install as a new application identity so the old application remains a rollback until acceptance testing succeeds.

## Non-goals for 2.1.0

- Anthropic API organization usage or billing.
- Reading `~/.claude/.credentials.json` or the "Claude Code-credentials" keychain items.
- A TypeScript rewrite.
- Claiming that undocumented provider interfaces are stable.
- Public multi-user telemetry, analytics, or a hosted service.

## Provider strategy

### Claude

The Claude provider preserves the upstream browser-session integration and its private `claude.ai/api/organizations/...` usage endpoints. The session is encrypted with Electron `safeStorage` under store keys `claude.*`, and the isolated persistent partition `persist:ai-usage-claude` holds the HTTP-only cookie. Both are unchanged from 2.0, so the existing login and history carry over. The renderer receives only normalized usage data and status codes.

On macOS the card's **Connect from Safari** button adopts the claude.ai `sessionKey` cookie Safari currently holds (read from Safari's `Cookies.binarycookies`; needs Full Disk Access). Only the installed (packaged) app reads Safari. A development run (`npm start`) uses the embedded sign-in window instead, so Full Disk Access is never granted to the stock Electron binary. On Windows/Linux the embedded claude.ai sign-in window is used. The Safari reader refuses a cookie store that is not a regular file or is over 32 MB and skips other sites' cookies without decoding them.

Disconnect asks for a second click in the panel. Disconnect and any failed sign-in wipe the whole isolated sign-in partition (all cookies and storage, including Google/Apple/Microsoft sign-in cookies) plus the encrypted key. Electron cookie encryption is enabled (`enableCookieEncryption` fuse). A refresh never runs during a sign-in, and a refresh that overlaps a sign-in discards its result instead of overwriting or deleting the new login.

## Normalized snapshot

Each provider returns:

- Provider identity and display name.
- Status, fetch timestamp, and stale state.
- Only the quota buckets allowed by the product display policy.
- A sanitized, stable error code.

Each quota bucket contains a stable ID, label, utilization percentage, optional window duration, optional reset time, and category. Raw provider payloads are not persisted.

## User experience

- The app is a menu bar app with no Dock icon (`LSUIElement`).
- On macOS the menu bar shows the icon plus the tightest current limit, e.g. `42%`. A `~` prefix means a last-known (stale) value and `–` means no data yet.
- Clicking the icon opens a dropdown panel anchored under it with the usage card (bars, reset times, connect/disconnect), an optional usage-history chart, and Settings. The panel hides when it loses focus.
- Right-clicking the icon offers Show usage, Refresh now, and Quit.
- On Windows/Linux the tray tooltip shows the stats.
- A logged-out account, provider outages, and stale data have distinct states.
- Settings control refresh interval, theme, warn/danger thresholds, usage alerts (per limit, once per threshold and reset window), local usage history (8 days), and launch at login.

## Privacy and security requirements

- No telemetry.
- No API keys.
- Claude Code's own credentials are never read.
- No plaintext Claude session key on disk.
- No credentials in renderer IPC, logs, diagnostics, fixtures, or history.
- The renderer is sandboxed, renderer networking remains disabled by Content Security Policy, and IPC handlers check the sender.
- Configuration file permissions are hardened to `0600` where supported.

## Migration and rollback

On first launch, the new application reads the old config as an immutable migration source. It imports supported settings and history, and copies the encrypted Claude credential only if OS-backed decryption succeeds. Failure requests a new Claude login without deleting old data. The old app is removed only after the packaged replacement passes live acceptance tests, and removal is recoverable through the macOS Trash.

## Acceptance criteria

- The connected Claude account is visible after one refresh on the target MBA.
- It displays only 5-hour, 7-day, and Fable limits; other scoped limits, credits, and spend never appear or enter history.
- The menu bar text shows the tightest current limit, and the panel opens under the icon and hides on focus loss.
- Disconnect and a failed sign-in wipe the isolated partition and encrypted key; a refresh overlapping a sign-in never overwrites or deletes the new login.
- Renderer and diagnostic payloads contain no authentication material.
- Old configuration remains intact after migration.
- Unit, integration, syntax, security, and packaged smoke checks pass.
- The installed replacement launches under `com.jameshan.aiusagewidget`.
- The upstream app is moved to Trash only after the replacement passes.

## Known risks

The Claude subscription data source is undocumented and can change without notice. Provider adapters, sanitized contract fixtures, version diagnostics, stale caching, and independent failure states reduce recovery time but cannot eliminate that risk.

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
- Replaced packaged `file://` dashboard loading with a secure, CSP-enforced custom protocol that exposes only an explicit local asset allowlist.
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
- Re-applied saved bounds after native macOS window creation and retained one draggable header-height onscreen so a deliberately edge-positioned HUD survives packaged relaunch without being pulled fully onscreen.

### 2026-08-30 — Packaged acceptance

- Verified the Electron 41.10.7 arm64 runtime against Electron's published archive checksum before packaging.
- Built a hardened-runtime, ad-hoc-signed arm64 app and DMG with ASAR integrity enforcement and disabled Node/CLI escape fuses.
- Passed all 21 automated tests, syntax checks, dependency audits, deep code-signature verification, DMG verification, and mounted-image inspection.
- Installed the 2.0.0 bundle under `com.jameshan.aiusagewidget`, confirmed both providers live, and confirmed that only the four approved bucket IDs exist in snapshots and history.
- Confirmed the native packaged window preserves user-selected geometry across relaunch and live refresh while retaining a recoverable draggable surface.
- Moved the legacy application bundle to Trash only after replacement acceptance; preserved its configuration contents and hardened that file to owner-only permissions.
- Corrected a packaged-only blank-window failure by serving the dashboard through the allowlisted custom protocol; verified rendered content and native drag/resize behavior in the rebuilt installed app.

### 2026-09-30 · 2.1.0 Claude in the menu bar

- Removed Codex support entirely: the Codex provider, Codex CLI discovery, the `codex app-server` child process, the Codex executable setting, and the Codex docs link.
- Added "Connect from Safari" on macOS: the installed app adopts the claude.ai `sessionKey` cookie Safari holds (needs Full Disk Access). A development run (`npm start`) and Windows/Linux use the embedded sign-in window. The reader refuses a cookie store that is not a regular file or is over 32 MB and skips other sites' cookies without decoding them.
- Disconnect (a second click in the panel) and any failed sign-in wipe the whole isolated sign-in partition plus the encrypted key. Enabled the `enableCookieEncryption` fuse. A refresh never runs during a sign-in, and an overlapping refresh discards its result.
- Replaced the floating HUD with a menu bar app: the tightest limit as text (e.g. `42%`), a dropdown panel under the icon, a right-click menu, and no Dock icon.
- Removed compact mode, corner snapping, opacity, always-on-top, every-Space, saved window positions, and the "menu bar only" toggle.
