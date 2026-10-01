# Threat Model

## Protected data

- Claude session cookie.
- Provider organization/account identifiers.
- Usage history and plan information.

## Trust boundaries

### Renderer

The renderer is treated as untrusted. Node integration and renderer networking are disabled. Preload exposes only fixed IPC methods. Provider responses are normalized and stripped of credentials before crossing IPC. The dashboard uses a secure custom protocol instead of `file://`; the main process serves only a fixed asset allowlist and leaves CSP enforcement enabled.

### Claude remote content

Remote Claude pages load only in dedicated sandboxed BrowserWindows with no preload. The session uses an isolated persistent partition. Disconnect and any failed sign-in wipe the whole partition (all cookies and storage, including Google/Apple/Microsoft sign-in cookies) plus the encrypted key. Electron cookie encryption is enabled (`enableCookieEncryption` fuse). Navigation and login domains are allowlisted. Hidden data fetch windows accept only HTTPS Claude API URLs.

### Safari cookie import

On macOS, "Connect from Safari" reads the claude.ai `sessionKey` cookie from Safari's `Cookies.binarycookies`, which needs Full Disk Access. Only the installed (packaged) app reads Safari. A development run (`npm start`) uses the embedded sign-in window, so Full Disk Access is never granted to the stock Electron binary. The reader refuses a cookie store that is not a regular file or is over 32 MB and skips other sites' cookies without decoding them. Claude Code's own credentials (`~/.claude/.credentials.json` and the "Claude Code-credentials" keychain items) are never read.

### Local storage

Claude credentials require Electron `safeStorage`; plaintext fallback is prohibited. The config is chmodded to owner-read/write where the OS supports POSIX modes. Migration never modifies the source config.

The old and new macOS app names use different `safeStorage` Keychain identities. First-run migration therefore launches the same application in a constrained legacy-helper mode. A fresh 256-bit key is passed through stdin; the helper decrypts with the old identity, wraps the credential with AES-256-GCM, and returns only ciphertext through stdout. The main process unwraps it in memory and immediately encrypts it with the new identity. The shared key and plaintext buffer are zeroed, no plaintext file is created, stderr is discarded, output is bounded, and the helper has a hard deadline.

## Logging policy

Normal operation logs only stable error codes. Debug diagnostics may include app, OS, and Electron versions plus resolved capability states. They may not include tokens, cookies, email addresses, organization IDs, complete provider payloads, or stderr beyond a sanitized bounded summary.

## Residual risk

The private Claude endpoint can change.
