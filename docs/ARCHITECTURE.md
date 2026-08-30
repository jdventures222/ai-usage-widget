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
        +-- Provider manager -- Codex provider -- one-shot local child process
        |
        +-- Versioned store -- normalized snapshots/history/settings only
```

The renderer is an untrusted presentation surface. It cannot fetch remote content, launch commands, choose arbitrary URLs, or access credentials. Provider code and secret handling stay in the main process.

## Provider contract

Providers implement `getStatus`, `fetchSnapshot`, `getDiagnostics`, and `dispose`. They return only the normalized objects defined in `src/shared/provider-contract.js`. The manager executes enabled providers independently, caches last-known successful snapshots, records sanitized history, and turns failures into provider-local states.

## Claude data flow

1. The main process decrypts the stored session key with Electron `safeStorage`.
2. It sets an HTTP-only cookie in a dedicated Electron session.
3. A hidden sandboxed BrowserWindow loads allowlisted Claude API URLs.
4. The provider validates and normalizes the JSON response.
5. Only the normalized snapshot reaches storage and IPC.

## Codex data flow

1. CLI discovery checks a validated user choice, GUI `PATH`, and known installation paths.
2. The main process spawns `codex app-server --stdio` without a shell.
3. The client initializes JSON-RPC and requests `account/rateLimits/read`.
4. `rateLimitsByLimitId` is parsed dynamically; the legacy single snapshot is a fallback.
5. The child is terminated and reaped before the snapshot is returned.

## Storage

The v2 store contains settings, normalized history, sanitized last-known snapshots, migration metadata, and the already-encrypted Claude session credential. It does not contain Codex authentication, raw provider responses, emails, or provider account IDs intended only for diagnostics.

## Compatibility policy

Unknown fields are ignored. Missing required fields become a recoverable provider error. New limit IDs and window durations render automatically. An unavailable RPC method produces `unsupported_version` rather than crashing or silently mislabeling data.
