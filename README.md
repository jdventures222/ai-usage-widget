# AI Usage Widget

A private, low-profile menu bar app for the Claude subscription usage that matters on this MacBook Air.

It tracks one Claude subscription account and shows only:

- The all-models 5-hour limit.
- The all-models 7-day limit.
- The Fable 7-day limit.

Other Claude scoped/model limits, spend controls, prepaid balances, and credits are discarded before display and history storage.

## Experience

- Lives in the macOS menu bar with no Dock icon (`LSUIElement`).
- The menu bar shows the icon plus the tightest current limit, e.g. `42%`. A `~` prefix means a last-known (stale) value and `–` means no data yet.
- Clicking the icon opens a dropdown panel anchored under it with the usage card (bars, reset times, connect/disconnect), an optional usage-history chart, and Settings. The panel hides when it loses focus.
- Right-clicking the icon offers Show usage, Refresh now, and Quit.
- On Windows/Linux the tray tooltip shows the stats.
- Settings: refresh interval, theme, warn/danger thresholds, usage alerts (per limit, once per threshold and reset window), local usage history (8 days), and launch at login.

## Data sources

### Claude

The account has a sandboxed, isolated persistent Electron browser session. Its session cookie stays in the main process and is encrypted using Electron `safeStorage` under store keys `claude.*` in partition `persist:ai-usage-claude`, unchanged from 2.0, so the existing login and history carry over.

To connect:

- **Connect from Safari** (macOS) adopts the claude.ai `sessionKey` cookie Safari currently holds, read from Safari's `Cookies.binarycookies`. It needs Full Disk Access. Only the installed (packaged) app reads Safari. A development run (`npm start`) uses the embedded sign-in window instead, so Full Disk Access is never granted to the stock Electron binary. The reader refuses a cookie store that is not a regular file or is over 32 MB and skips other sites' cookies without decoding them.
- On Windows/Linux an embedded claude.ai sign-in window runs in the isolated session.

Disconnect asks for a second click in the panel. Disconnect and any failed sign-in wipe the whole isolated sign-in partition (all cookies and storage, including Google/Apple/Microsoft sign-in cookies) plus the encrypted key. Electron cookie encryption is enabled (`enableCookieEncryption` fuse). A refresh never runs during a sign-in, and a refresh that overlaps a sign-in discards its result instead of overwriting or deleting the new login.

Claude Code's own credentials (`~/.claude/.credentials.json` and the "Claude Code-credentials" keychain items) are never read.

The Claude subscription interface used here is private. It can change without notice. This project is not affiliated with Anthropic.

## First launch and migration

The new app uses its own identity and data directory:

```text
~/Library/Application Support/ai-usage-widget/
```

On first launch it reads the old Claude Usage Widget config as an immutable migration source. Supported history and settings are normalized, and a constrained one-time helper re-encrypts the existing Claude credential from the old Keychain identity to the new one without writing plaintext.

The old config is not modified. The old application should be moved to Trash only after the replacement passes live Claude, relaunch, and packaged checks.

## Development

Requirements: Node.js 18+ and npm 9+.

```bash
git clone https://github.com/jdventures222/ai-usage-widget.git
cd ai-usage-widget
npm ci
npm test
npm run lint
npm run audit:runtime
npm start
```

If the shell has `ELECTRON_RUN_AS_NODE` set, remove it for a development launch:

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

Build an Apple Silicon macOS bundle:

```bash
npm run build:mac:unpacked
```

## Distribution status

Local development and packaged validation are supported. A broadly distributable macOS release requires a Developer ID Application certificate and Apple notarization credentials. Do not describe an unsigned or development-signed build as notarized.

## Security and privacy

- No telemetry or hosted service.
- No renderer networking.
- No plaintext credential fallback.
- No credential-bearing IPC or diagnostics.
- Configuration permissions are hardened to owner read/write (`0600`) where supported.
- Sandboxed renderer; credentials stay in the main process and IPC checks the sender.
- Raw provider responses are never persisted.

See [Product requirements](docs/PRD.md), [architecture](docs/ARCHITECTURE.md), and [threat model](docs/THREAT-MODEL.md).

## Attribution

AI Usage Widget is derived from [Claude Usage Widget](https://github.com/SlavomirDurej/claude-usage-widget) by Slavomir Durej under the MIT License. Upstream copyright and attribution are preserved in the license, package metadata, Git history, and [attribution notes](docs/ATTRIBUTION.md).

Recent upstream contributors whose work is represented in the v1.7.6 baseline include:

- [@cwil2072](https://github.com/cwil2072) - macOS minimize/restore fix, usage history graph
- [@dion-jy](https://github.com/dion-jy) - Login flow architecture improvements
- [@goooseman](https://github.com/goooseman) - Login window security improvements
- [@sergkuzn](https://github.com/sergkuzn) - Linux desktop launcher & autostart documentation
- [@Dolphin2ii](https://github.com/Dolphin2ii) - Electron/electron-builder security update
- [@torsten-liermann](https://github.com/torsten-liermann) - Per-model weekly limit support (Fable)
- [@gastyg](https://github.com/gastyg) - Fable row for compact mode
- [@irishpolyglot](https://github.com/irishpolyglot) - Fable timer-pairing bug fix

## License

MIT. See [LICENSE](LICENSE).
