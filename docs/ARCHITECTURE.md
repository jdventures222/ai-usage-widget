# Architecture

## Process boundary

```text
Renderer (no Node, no network)
        |
        | narrow validated IPC
        v
Electron main process
        |
        +-- Provider manager -- Claude provider -- isolated browser session
        |
        +-- Versioned store -- normalized snapshots/history/settings only
```

The renderer is an untrusted presentation surface. It cannot fetch remote content, launch commands, choose arbitrary URLs, or access credentials. Provider code and secret handling stay in the main process. A standard, secure `ai-widget://dashboard` protocol serves only seven explicitly allowlisted packaged assets; it rejects all other hosts, paths, methods, and query strings without bypassing Content Security Policy.

## Provider contract

Providers implement `getStatus`, `fetchSnapshot`, `getDiagnostics`, and `dispose`. They return only the normalized objects defined in `src/shared/provider-contract.js`. The manager executes enabled providers independently, caches last-known successful snapshots, records sanitized history, and turns failures into provider-local states.

## Claude data flow

The session uses store keys `claude.*` and partition `persist:ai-usage-claude`, unchanged from 2.0.

1. The main process decrypts the stored session key with Electron `safeStorage`.
2. It sets an HTTP-only cookie in the dedicated Electron session.
3. A hidden sandboxed BrowserWindow loads allowlisted Claude API URLs.
4. The provider validates and normalizes the JSON response.
5. Only the normalized snapshot reaches storage and IPC.

## Claude sign-in

On macOS the installed app's "Connect from Safari" adopts the claude.ai `sessionKey` cookie Safari currently holds, read from Safari's `Cookies.binarycookies` (needs Full Disk Access). The reader refuses a cookie store that is not a regular file or is over 32 MB and skips other sites' cookies without decoding them. A development run (`npm start`) and Windows/Linux use an embedded claude.ai sign-in window in the isolated session, so Full Disk Access is never granted to the stock Electron binary.

Disconnect (confirmed by a second click in the panel) and any failed sign-in wipe the whole isolated partition plus the encrypted key. A refresh never runs during a sign-in, and a refresh that overlaps a sign-in discards its result.

## Storage

The v2 store contains settings, normalized history, sanitized last-known snapshots, migration metadata, and the already-encrypted Claude session credential. It does not contain Claude Code's credentials, raw provider responses, emails, or provider account IDs intended only for diagnostics.

## Presentation policy

Provider adapters are deliberately shape-tolerant but output only product-approved limits. The Claude provider emits only its 5-hour, 7-day, and Fable buckets and discards every other scoped limit, spend response, and credit response. The same filtered snapshot feeds the menu bar text, panel, notifications, and history, so hidden buckets cannot leak into a secondary surface.

The app is a menu bar app with no Dock icon. The menu bar text shows the tightest current limit. The main process anchors the dropdown panel under the tray icon and hides it when it loses focus. On Windows/Linux the tray tooltip shows the stats.

## Compatibility policy

Unknown fields are ignored. Missing required fields become a recoverable provider error. New window durations within approved limit IDs remain dynamic; new limit IDs stay hidden until explicitly approved in the product policy. An unavailable RPC method produces `unsupported_version` rather than crashing or silently mislabeling data.
