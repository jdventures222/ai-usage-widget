# Threat Model

## Protected data

- Claude session cookie.
- Provider organization/account identifiers.
- Usage history and plan information.
- Local executable paths.

## Trust boundaries

### Renderer

The renderer is treated as untrusted. Node integration and renderer networking are disabled. Preload exposes only fixed IPC methods. Provider responses are normalized and stripped of credentials before crossing IPC.

### Claude remote content

Remote Claude pages load only in dedicated sandboxed BrowserWindows with no preload. Navigation and login domains are allowlisted. Hidden data fetch windows accept only HTTPS Claude API URLs.

### Codex child process

Only a resolved executable selected by discovery or the native file picker is launched. Arguments are constant, shell invocation is disabled, stdout/stderr are bounded, JSON is shape-checked, and a deadline forces cleanup.

### Local storage

Claude credentials require Electron `safeStorage`; plaintext fallback is prohibited. The config is chmodded to owner-read/write where the OS supports POSIX modes. Migration never modifies the source config.

The old and new macOS app names use different `safeStorage` Keychain identities. First-run migration therefore launches the same application in a constrained legacy-helper mode. A fresh 256-bit key is passed through stdin; the helper decrypts with the old identity, wraps the credential with AES-256-GCM, and returns only ciphertext through stdout. The main process unwraps it in memory and immediately encrypts it with the new identity. The shared key and plaintext buffer are zeroed, no plaintext file is created, stderr is discarded, output is bounded, and the helper has a hard deadline.

## Logging policy

Normal operation logs only stable error codes. Debug diagnostics may include app, OS, Electron, and CLI versions plus resolved capability states. They may not include tokens, cookies, email addresses, organization IDs, complete provider payloads, or stderr beyond a sanitized bounded summary.

## Residual risk

The private Claude endpoint and experimental Codex app-server interface can change. A malicious replacement `codex` executable chosen by the user would execute with the user's permissions; native file selection, realpath resolution, executable checks, and visible diagnostics reduce accidental selection but cannot make an untrusted executable safe.
